import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, interval, shareReplay, startWith, Subject, switchMap } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as PGPubsub from 'pg-pubsub';
import * as fs from 'node:fs';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private client: RPCClient;
    private _newBlockTemplate$: BehaviorSubject<IBlockTemplate> = new BehaviorSubject(undefined);
    private pubsubInstance: PGPubsub;
    private resetTemplateInterval$ = new Subject<void>();

    public miningInfo: IMiningInfo;
    public newBlockTemplate$ = this._newBlockTemplate$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {

        this.pubsubInstance = new (PGPubsub as any)({
            host: this.configService.get('DB_HOST'),
            port: parseInt(this.configService.get('DB_PORT')),
            user: this.configService.get('DB_USERNAME'),
            password: this.configService.get('DB_PASSWORD'),
            database: this.configService.get('DB_DATABASE')
        })

        const url = this.configService.get('BITCOIN_RPC_URL');
        let user = this.configService.get('BITCOIN_RPC_USER');
        let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE')

        if (cookiefile != undefined && cookiefile != '') {
            try {
                const cookie = fs.readFileSync(cookiefile).toString().split(':');
                if (cookie.length < 2) {
                    console.error(`Invalid cookie file format: ${cookiefile} — expected "user:password"`);
                } else {
                    user = cookie[0];
                    pass = cookie[1];
                }
            } catch (e: any) {
                console.error(`Failed to read Bitcoin RPC cookie file "${cookiefile}": ${e.message}`);
            }
        }

        this.client = new RPCClient({ url, port, timeout, user, pass });

        this.client.getrpcinfo().then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });

        this.miningInfo = await this.getMiningInfo();
        if (this.miningInfo == null) {
            console.error('FATAL: Could not get initial mining info from Bitcoin RPC. Check RPC connection.');
            process.exit(1);
        }
        console.log(`Initial mining info: height=${this.miningInfo.blocks} difficulty=${this.miningInfo.difficulty}`);

        const processTag = process.env.MASTER === 'true' ? '[Master]' : `[Worker:${process.pid}]`;
        console.log(`${processTag} Bitcoin RPC service initialized`);
        if (process.env.MASTER != 'true') {
            this.pubsubInstance.addChannel('miningInfo', async (miningInfo: IMiningInfo) => {
                try {
                    this.miningInfo = miningInfo;
                    const savedBlockTemplate = await this.rpcBlockService.getSavedBlockTemplate(miningInfo.blocks);
                    if (savedBlockTemplate == null || savedBlockTemplate.data == null) {
                        console.error(`${processTag} No saved block template found for height ${miningInfo.blocks}`);
                        return;
                    }
                    this._newBlockTemplate$.next(JSON.parse(savedBlockTemplate.data));
                    console.log(`${processTag} Received block template via pubsub, height=${miningInfo.blocks}`);
                } catch (e: any) {
                    console.error(`${processTag} Error processing pubsub miningInfo: ${e.message}`);
                }
            });
        } else {
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;

            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.error('ZMQ Unable to connect, Retrying');
            });

            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);

            // Between new blocks we want refresh jobs with the latest transactions
            this.resetTemplateInterval$.pipe(
                startWith(null),
                switchMap(() => interval(60000))
            ).subscribe(async () => {
                await this.getAndBroadcastLatestTemplate();
            });

        }

    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        try {
            for await (const [topic, msg] of sock) {
                console.log("New Block");
                try {
                    this.miningInfo = await this.getMiningInfo();
                    await this.getAndBroadcastLatestTemplate();
                    //Reset the block update interval
                    this.resetTemplateInterval$.next();
                } catch (e: any) {
                    console.error('Error processing new block:', e.message);
                }
            }
        } catch (e: any) {
            console.error('ZMQ listener error:', e.message);
        }
    }

    public async getAndBroadcastLatestTemplate() {
        const blockTemplate = await this.loadBlockTemplate(this.miningInfo.blocks);
        this._newBlockTemplate$.next(blockTemplate);
        try {
            await this.pubsubInstance.publish('miningInfo', this.miningInfo);
        } catch (e: any) {
            console.error(`[Master] PG pubsub publish failed: ${e.message}`);
        }
    }

    private async loadBlockTemplate(blockHeight: number) {

        console.log(`Master fetching block template ${blockHeight}`);

        let blockTemplate: IBlockTemplate;
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                blockTemplate = await this.client.getblocktemplate({
                    template_request: {
                        rules: ['segwit'],
                        mode: 'template',
                        capabilities: ['serverlist', 'proposal']
                    }
                });
                if (blockTemplate != null) break;
            } catch (e: any) {
                console.error(`loadBlockTemplate attempt ${attempt}/${maxRetries} failed: ${e.message}`);
                if (attempt === maxRetries) throw e;
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }

        try {
            console.log(`Saving block ${blockHeight}`);
            await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));
            console.log('block saved');
        } catch (e: any) {
            console.error('Error saving block', e.message);
        }

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.client.getmininginfo();
        } catch (e: any) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.client.submitblock({
                hexdata
            });
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e: any) {
            response = e?.message || String(e);
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }
}
