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


@Injectable()
export class StratumV1Service implements OnModuleInit {

  private activeConnections = 0;
  private totalConnections = 0;
  private totalDisconnections = 0;
  private errorDisconnections = 0;
  private timeoutDisconnections = 0;

  // Delta counters for periodic logging (reset each interval)
  private deltaConnections = 0;
  private deltaDisconnections = 0;
  private deltaErrors = 0;
  private deltaTimeouts = 0;

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

      if (process.env.NODE_APP_INSTANCE == '0') {
        await this.clientService.deleteAll();
      }
      setTimeout(() => {
        this.startSocketServer();
      }, 1000 * 10)

      // Log connection metrics every 5 seconds
      setInterval(() => {
        const instanceId = process.env.NODE_APP_INSTANCE ?? '0';
        console.log(`[Worker ${instanceId}] active=${this.activeConnections} | +${this.deltaConnections} conn, -${this.deltaDisconnections} disc, err=${this.deltaErrors}, timeout=${this.deltaTimeouts} | total: conn=${this.totalConnections} disc=${this.totalDisconnections}`);
        this.deltaConnections = 0;
        this.deltaDisconnections = 0;
        this.deltaErrors = 0;
        this.deltaTimeouts = 0;
      }, 5 * 1000);
  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {

      // Reject ghost sockets (client already disconnected before we process)
      if (!socket.remoteAddress || socket.destroyed) {
        socket.destroy();
        return;
      }

      //5 min
      socket.setTimeout(1000 * 60 * 5);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);

      this.activeConnections++;
      this.totalConnections++;
      this.deltaConnections++;

      const client = new StratumV1Client(
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


      socket.on('close', async (hadError: boolean) => {
        this.activeConnections--;
        this.totalDisconnections++;
        this.deltaDisconnections++;
        if (hadError) {
          this.errorDisconnections++;
          this.deltaErrors++;
        }
        if (client.extraNonceAndSessionId != null) {
          // Handle socket disconnection
          await client.destroy();
        }
      });

      socket.on('timeout', () => {
        this.timeoutDisconnections++;
        this.deltaTimeouts++;
        socket.end();
        socket.destroy();
      });

      socket.on('error', async (error: Error) => { });


    });

    server.maxConnections = 65535;

    server.listen(process.env.STRATUM_PORT, () => {
      const instanceId = process.env.NODE_APP_INSTANCE ?? '0';
      console.log(`[Worker ${instanceId}] Stratum server is listening on port ${process.env.STRATUM_PORT}`);
    });

  }

}