import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { filter, map, Observable, shareReplay, tap } from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        clearJobs: boolean;
    };
}

@Injectable()
export class StratumV1JobsService {

    public newMiningJob$: Observable<IJobTemplate>;
    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;
    public jobs: { [jobId: string]: MiningJob } = {};
    public blocks: { [id: number]: IJobTemplate } = {};

    private lastBlockHeight = 0;
    public broadcastGeneration = 0;
    public latestJobTemplate: IJobTemplate = null;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {

        this.newMiningJob$ = this.bitcoinRpcService.newBlockTemplate$.pipe(
            map((blockTemplate) => {

                if (process.env.MASTER == 'true') {
                    console.log('Updating block template');
                }

                let clearJobs = false;
                const currentBlockHeight = this.bitcoinRpcService.miningInfo.blocks;

                if (this.lastBlockHeight == 0 || this.lastBlockHeight != currentBlockHeight) {
                    console.log('New template is new block, clearing jobs');
                    clearJobs = true;
                    this.lastBlockHeight = currentBlockHeight;
                }

                const currentTime = Math.floor(new Date().getTime() / 1000);
                return {
                    version: blockTemplate.version,
                    bits: parseInt(blockTemplate.bits, 16),
                    prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
                    transactions: blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data)),
                    coinbasevalue: blockTemplate.coinbasevalue,
                    timestamp: blockTemplate.mintime > currentTime ? blockTemplate.mintime : currentTime,
                    networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
                    clearJobs,
                    height: blockTemplate.height
                };
            }),
            filter(next => next != null),
            map(({ version, bits, prevHash, transactions, timestamp, coinbasevalue, networkDifficulty, clearJobs, height }) => {
                const block = new bitcoinjs.Block();

                //create an empty coinbase tx
                const tempCoinbaseTx = new bitcoinjs.Transaction();
                tempCoinbaseTx.version = 2;
                tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
                tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
                transactions.unshift(tempCoinbaseTx);

                const transactionBuffers = transactions.map(tx => tx.getHash(false));

                const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
                const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
                block.merkleRoot = merkleBranches.pop();

                // remove the first (coinbase) and last (root) element from the branch
                const merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'))

                block.prevHash = prevHash;
                block.version = version;
                block.bits = bits;
                block.timestamp = timestamp;

                block.transactions = transactions;
                block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(transactions, true);

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;
                return {
                    block,
                    merkle_branch,
                    blockData: {
                        id,
                        creation: new Date().getTime(),
                        coinbasevalue,
                        networkDifficulty,
                        height,
                        clearJobs
                    }
                }
            }),
            tap((data) => {
                if (data.blockData.clearJobs) {
                    this.broadcastGeneration++;
                    this.blocks = {};
                    this.jobs = {};
                } else {
                    const now = new Date().getTime();
                    // Delete old templates (5 minutes)
                    for (const templateId in this.blocks) {
                        if (now - this.blocks[templateId].blockData.creation > (1000 * 60 * 5)) {
                            delete this.blocks[templateId];
                        }
                    }
                    // Delete old jobs (5 minutes)
                    for (const jobId in this.jobs) {
                        if (now - this.jobs[jobId].creation > (1000 * 60 * 5)) {
                            delete this.jobs[jobId];
                        }
                    }
                }
                this.blocks[data.blockData.id] = data;
                this.latestJobTemplate = data;
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        )

        this.newMiningJob$.subscribe();
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;
        const exponent: number = (nBits >> 24) & 0xff;

        const target: number = mantissa * Math.pow(256, (exponent - 3));

        const maxTarget = Math.pow(2, 208) * 65535;
        const difficulty: number = maxTarget / target;

        return difficulty;
    }

    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    public getNextId(): string {
        return (this.latestJobId++).toString(16);
    }

    public getNextTemplateId(): string {
        return (this.latestJobTemplateId++).toString(16);
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
    }

    public getJobById(jobId: string): MiningJob | undefined {
        return this.jobs[jobId];
    }

    public getJobTemplateById(id: string): IJobTemplate | undefined {
        return this.blocks[id];
    }

}
