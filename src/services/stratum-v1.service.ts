import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { ExternalSharesService } from './external-shares.service';

import { readFileSync } from 'fs';
import { TlsOptions, TLSSocket, createServer } from 'tls';
import * as path from 'path';



@Injectable()
export class StratumV1Service implements OnModuleInit {

    private socketTimeout = 0;
    private emptySocket = 0;
    private normalClosure = 0;
    private errorClosure = 0;
    private activeConnections = 0;
    private totalConnections = 0;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService
    ) {

    }

    async onModuleInit(): Promise<void> {

        if (process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
        }

        // wait for all the other processes to init for an even connection distribution
        setTimeout(() => {
            process.env.STRATUM_PORTS.split(',').forEach(port => {
                this.startSocketServer(parseInt(port));
            });
            if (process.env.STRATUM_SECURE?.toLowerCase() === 'true') {
                process.env.SECURE_STRATUM_PORTS.split(',').forEach(port => {
                    this.startSecureSocketServer(parseInt(port));
                });
            }
        }, (10000));

        const processTag = `[Worker:${process.pid}]`;
        setInterval(() => {
            console.log(`${processTag} Connections: active=${this.activeConnections} total=${this.totalConnections} | Socket stats: ${this.emptySocket} empty, ${this.socketTimeout} timeouts, ${this.normalClosure} normal close, ${this.errorClosure} error close`);
            this.emptySocket = 0;
            this.socketTimeout = 0;
            this.normalClosure = 0;
            this.errorClosure = 0;
            this.totalConnections = 0;
        }, 1000 * 60);

    }

    private createClient(socket: Socket): StratumV1Client {
        return new StratumV1Client(
            socket,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.clientStatisticsService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
            this.externalSharesService
        );
    }

    private setupSocketHandlers(socket: Socket, client: StratumV1Client) {
        this.activeConnections++;
        this.totalConnections++;

        const cleanup = async (reason: string) => {
            this.activeConnections--;
            if (client.extraNonceAndSessionId != null) {
                try {
                    await client.destroy();
                } catch (e: any) {
                    console.error(`Client destroy error [${client.extraNonceAndSessionId}]: ${e.message}`);
                }
                if (reason == 'Error') {
                    this.errorClosure++;
                } else {
                    this.normalClosure++;
                }
            }
            if (!socket.destroyed) {
                socket.end();
                socket.destroy();
            }
        };

        socket.on('close', async (hadError: boolean) => {
            await cleanup(hadError ? "Error" : "Normal Closure");
        });

        socket.on('timeout', async () => {
            if (socket.bytesRead == 0 || socket.bytesWritten == 0) {
                this.emptySocket++;
            } else {
                this.socketTimeout++;
            }
            await cleanup("Timeout");
        });

        socket.on('error', async (error: Error) => {
            await cleanup("Error");
        });
    }

    private startSocketServer(port: number) {
        const server = new Server(async (socket: Socket) => {

            // Reject ghost sockets (client already disconnected before we process)
            if (!socket.remoteAddress || socket.destroyed) {
                socket.destroy();
                return;
            }

            // Set 15-minute timeout
            socket.setTimeout(1000 * 60 * 15);
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 30000);

            const client = this.createClient(socket);
            this.setupSocketHandlers(socket, client);
        });

        server.maxConnections = 65535;

        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });

        server.listen(port, () => {
            console.log(`Stratum server is listening on port ${port}`);
        });

    }

    private startSecureSocketServer(port: number) {

        const currentDirectory = process.cwd();
        const keyPath = path.join(currentDirectory, 'secrets', 'key.pem');
        const certPath = path.join(currentDirectory, 'secrets', 'cert.pem');

        const tlsOptions: TlsOptions = {
            key: readFileSync(keyPath),
            cert: readFileSync(certPath),
        };

        const server = createServer(tlsOptions, async (socket: TLSSocket) => {

            if (!socket.remoteAddress || socket.destroyed) {
                socket.destroy();
                return;
            }

            socket.setTimeout(1000 * 60 * 15);
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 30000);

            const client = this.createClient(socket);
            this.setupSocketHandlers(socket, client);
        });

        server.maxConnections = 65535;

        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });

        server.listen(port, () => {
            console.log(`Stratum TLS server is listening on port ${port}`);
        });

    }

}
