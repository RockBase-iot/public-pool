import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { DifficultyUtils } from '../utils/difficulty.utils';


export class StratumV1Client {

    public clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: ReturnType<typeof setInterval>[] = [];

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 0.001;
    private isDestroyed = false;

    private clientEntity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;

    private buffer: string = '';

    private miningSubmissionHashes = new Set<string>()

    // Broadcast queue: serializes job notifications to prevent event loop blocking
    private static broadcastQueue: { gen: number, fn: () => Promise<void> }[] = [];
    private static broadcastProcessing = false;
    private static currentBroadcastGen = 0;
    private static readonly BROADCAST_BATCH_SIZE = 20;

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService
    ) {

        this.socket.on('data', this.handleData.bind(this));

    }

    private processingMessages = false;
    private pendingData: string[] = [];

    private static readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

    private handleData(data: Buffer) {
        if (this.isDestroyed) return;
        this.buffer += data.toString();
        if (this.buffer.length > StratumV1Client.MAX_BUFFER_SIZE) {
            console.warn(`Buffer exceeded max size for client [${this.extraNonceAndSessionId}], disconnecting`);
            this.safeDisconnect();
            return;
        }
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        const messages = lines.filter(m => m.length > 0);
        if (messages.length === 0) return;

        this.pendingData.push(...messages);
        this.processMessages();
    }

    private async processMessages() {
        if (this.processingMessages || this.isDestroyed) return;
        this.processingMessages = true;

        while (this.pendingData.length > 0 && !this.isDestroyed) {
            const msg = this.pendingData.shift();
            try {
                await this.handleMessage(msg);
            } catch (e: any) {
                if (!this.isDestroyed) {
                    console.error(`Unhandled message error [${this.extraNonceAndSessionId}]: ${e.code || e.message}`);
                }
                this.safeDisconnect();
                break;
            }
        }

        this.processingMessages = false;
    }

    public async destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        if (this.clientEntity?.id) {
            try {
                await this.clientService.delete(this.clientEntity.id);
            } catch (e: any) {
                console.error(`Failed to delete client [${this.extraNonceAndSessionId}]: ${e.message}`);
            }
        }

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach(work => {
            clearInterval(work);
        });
    }

    private safeDisconnect() {
        if (this.isDestroyed) return;
        this.destroy();
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4);
        const randomNumber = randomBytes.readUInt32BE(0);
        const hexString = randomNumber.toString(16).padStart(8, '0');
        return hexString;
    }


    private async handleMessage(message: string) {
        if (this.isDestroyed) return;

        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            this.safeDisconnect();
            return;
        }

        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
                        this.extraNonceAndSessionId = this.getRandomHexString();
                    }

                    this.clientSubscription = subscriptionMessage;
                    const success = await this.write(JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId)) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }

                } else {
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;
                    if (this.clientSuggestedDifficulty == null && this.clientAuthorization.startingDiff != null && this.clientAuthorization.startingDiff > this.sessionDifficulty) {
                        this.sessionDifficulty = this.clientAuthorization.startingDiff;
                    }
                    const success = await this.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {

                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                    const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    if (!success) {
                        return;
                    }
                    this.usedSuggestedDifficulty = true;
                } else {
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
            case eRequestMethod.SUBMIT: {

                if (this.stratumInitialized == false) {
                    // Silently ignore - miner sent SUBMIT before handshake completed.
                    return;
                }


                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        const success = await this.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                        if (!success) {
                            return;
                        }
                    }


                } else {
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
        }


        if (this.clientSubscription != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            try {
                await this.initStratum();
            } catch (e: any) {
                console.error(`[${this.extraNonceAndSessionId}] initStratum failed: ${e.message}`);
                this.safeDisconnect();
            }

        }
    }

    private async initStratum() {
        this.stratumInitialized = true;

        if (this.validateHeaderCompliance(this.clientSubscription.userAgent)) {
            console.log(`Non compliant connection from userAgent: ${this.clientSubscription.userAgent}`);
            await this.socket.end();
            return;
        }

        // Use env DEFAULT_DIFFICULTY if set and miner didn't suggest one
        if (!this.usedSuggestedDifficulty) {
            const envDiff = parseFloat(this.configService.get('DEFAULT_DIFFICULTY'));
            if (Number.isFinite(envDiff) && envDiff > 0) {
                this.sessionDifficulty = envDiff;
            }
        }

        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                this.sessionDifficulty = 0.1;
            }
        }

        if (this.clientSuggestedDifficulty == null) {
            const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
        }

        // Send the current job immediately to this client (bypass broadcast queue)
        // so the miner doesn't have to wait behind hundreds of other clients
        let initialTemplateId: string = null;
        const latestTemplate = this.stratumV1JobsService.latestJobTemplate;
        if (latestTemplate) {
            initialTemplateId = latestTemplate.blockData.id;
            try {
                await this.sendNewMiningJob(latestTemplate);
            } catch (e: any) {
                if (!this.isDestroyed) {
                    console.error(`Initial job send error [${this.extraNonceAndSessionId}]: ${e.code || e.message}`);
                }
                this.safeDisconnect();
                return;
            }
        }

        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe((jobTemplate) => {
            if (this.isDestroyed) return;

            // Skip the replayed initial template since we already sent it directly
            if (initialTemplateId && jobTemplate.blockData.id === initialTemplateId) {
                initialTemplateId = null;
                return;
            }
            initialTemplateId = null;

            if (jobTemplate.blockData.clearJobs) {
                this.miningSubmissionHashes.clear();
            }

            // Coordinate broadcast generation for stale-cancellation on new blocks
            const gen = this.stratumV1JobsService.broadcastGeneration;
            if (gen !== StratumV1Client.currentBroadcastGen) {
                StratumV1Client.currentBroadcastGen = gen;
                StratumV1Client.broadcastQueue.length = 0;
            }

            StratumV1Client.broadcastQueue.push({
                gen,
                fn: async () => {
                    if (this.isDestroyed) return;
                    try {
                        await this.sendNewMiningJob(jobTemplate);
                    } catch (e: any) {
                        if (!this.isDestroyed) {
                            console.error(`Job send error [${this.extraNonceAndSessionId}]: ${e.code || e.message}`);
                        }
                        this.safeDisconnect();
                    }
                }
            });

            StratumV1Client.processBroadcastQueue();
        });

        this.backgroundWork.push(
            setInterval(async () => {
                await this.checkDifficulty();
            }, 5 * 60 * 1000)
        );

    }

    private static async processBroadcastQueue() {
        if (StratumV1Client.broadcastProcessing) return;
        StratumV1Client.broadcastProcessing = true;

        let count = 0;
        while (StratumV1Client.broadcastQueue.length > 0) {
            const item = StratumV1Client.broadcastQueue.shift();
            if (item.gen !== StratumV1Client.currentBroadcastGen) continue;
            try {
                await item.fn();
            } catch (e) {
                // Individual errors handled inside fn
            }
            if (++count % StratumV1Client.BROADCAST_BATCH_SIZE === 0) {
                // Yield to event loop every N clients so I/O callbacks can run
                await new Promise<void>(r => setImmediate(r));
            }
        }

        StratumV1Client.broadcastProcessing = false;
        // Re-check: items may have been added during the final batch
        if (StratumV1Client.broadcastQueue.length > 0) {
            StratumV1Client.processBroadcastQueue();
        }
    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {

        let payoutInformation = [
            { address: this.clientAuthorization.address, percent: 100 }
        ];

        const networkConfig = this.configService.get('NETWORK');
        let network;

        if (networkConfig === 'mainnet') {
            network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'testnet') {
            network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'regtest') {
            network = bitcoinjs.networks.regtest;
        } else {
            throw new Error('Invalid network configuration');
        }

        const job = new MiningJob(
            this.configService,
            network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate
        );

        this.stratumV1JobsService.addJob(job);


        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        if (this.clientEntity == null) {
            if (this.creatingEntity == null) {
                this.creatingEntity = (async () => {
                    try {
                        this.clientEntity = await this.clientService.insert({
                            sessionId: this.extraNonceAndSessionId,
                            address: this.clientAuthorization.address,
                            clientName: this.clientAuthorization.worker,
                            userAgent: this.clientSubscription.userAgent,
                            startTime: new Date(),
                            bestDifficulty: 0
                        });
                    } catch (e: any) {
                        console.error(`[${this.extraNonceAndSessionId}] Failed to create client entity: ${e.message}`);
                    } finally {
                        this.creatingEntity = null;
                    }
                })();
            }
            await this.creatingEntity;
        }

        if (this.clientEntity == null) {
            console.error(`[${this.extraNonceAndSessionId}] Client entity is null after creation attempt, disconnecting`);
            this.safeDisconnect();
            return false;
        }

        const submissionHash = submission.jobId + ':' + submission.hash();
        if (this.miningSubmissionHashes.size > 10000) {
            // Evict oldest half instead of clearing everything — preserves recent dedup coverage
            const iter = this.miningSubmissionHashes.values();
            const deleteCount = 5000;
            for (let i = 0; i < deleteCount; i++) {
                const val = iter.next();
                if (val.done) break;
                this.miningSubmissionHashes.delete(val.value);
            }
        }
        if (this.miningSubmissionHashes.has(submissionHash)) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.DuplicateShare,
                'Duplicate share').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        } else {
            this.miningSubmissionHashes.add(submissionHash);
        }

        const job = this.stratumV1JobsService.getJobById(submission.jobId);

        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job Template not found').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }


        const updatedJobBlock = job.copyAndUpdateBlock(
            jobTemplate,
            parseInt(submission.versionMask, 16),
            parseInt(submission.nonce, 16),
            this.extraNonceAndSessionId,
            submission.extraNonce2,
            parseInt(submission.ntime, 16)
        );
        const header = updatedJobBlock.toBuffer(true);
        const { submissionDifficulty } = DifficultyUtils.calculateDifficulty(header);


        if (submissionDifficulty >= this.sessionDifficulty) {

            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                console.log(`!!! BLOCK FOUND !!! height=${jobTemplate.blockData.height} miner=${this.clientAuthorization.address} worker=${this.clientAuthorization.worker} difficulty=${submissionDifficulty}`);
                const blockHex = updatedJobBlock.toHex(false);
                const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
                await this.blocksService.save({
                    height: jobTemplate.blockData.height,
                    minerAddress: this.clientAuthorization.address,
                    worker: this.clientAuthorization.worker,
                    sessionId: this.extraNonceAndSessionId,
                    blockData: blockHex
                });

                await this.notificationService.notifySubscribersBlockFound(this.clientAuthorization.address, jobTemplate.blockData.height, updatedJobBlock, result);
                if (result === 'SUCCESS!') {
                    console.log(`Block ${jobTemplate.blockData.height} accepted by network, resetting best difficulty and shares`);
                    await this.addressSettingsService.resetBestDifficultyAndShares();
                } else {
                    console.error(`Block ${jobTemplate.blockData.height} submission result: ${result}`);
                }
            }
            try {
                this.statistics.addShares(this.clientEntity, this.sessionDifficulty);
                const now = new Date();
                this.clientService.heartbeatBulkAsync(this.clientEntity.id, this.statistics.hashRate, now);
                this.clientEntity.updatedAt = now;

            } catch (e: any) {
                console.error(`Statistics DB error [${this.extraNonceAndSessionId}]: ${e.code || e.message}`);
            }

            try {
                if (submissionDifficulty > this.clientEntity.bestDifficulty) {
                    await this.clientService.updateBestDifficulty(this.clientEntity.id, submissionDifficulty);
                    this.clientEntity.bestDifficulty = submissionDifficulty;
                    if (submissionDifficulty > (await this.addressSettingsService.getSettings(this.clientAuthorization.address, true)).bestDifficulty) {
                        await this.addressSettingsService.updateBestDifficulty(this.clientAuthorization.address, submissionDifficulty, this.clientEntity.userAgent);
                    }
                }
            } catch (e: any) {
                console.error(`BestDifficulty DB error [${this.extraNonceAndSessionId}]: ${e.code || e.message}`);
            }


            const externalShareSubmissionEnabled: boolean = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() == 'true';
            const minimumDifficultyConfig = this.configService.get('MINIMUM_DIFFICULTY');
            const parsedDifficulty = minimumDifficultyConfig != null && minimumDifficultyConfig !== '' ? parseFloat(minimumDifficultyConfig) : NaN;
            const minimumDifficulty: number = Number.isFinite(parsedDifficulty) ? parsedDifficulty : 1000000000000.0; // 1T
            if (externalShareSubmissionEnabled && submissionDifficulty >= minimumDifficulty) {
                this.externalSharesService.submitShare({
                    worker: this.clientAuthorization.worker,
                    address: this.clientAuthorization.address,
                    userAgent: this.clientSubscription.userAgent,
                    header: header.toString('hex'),
                    externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool'
                });
            }

        } else {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();

            const success = await this.write(err);
            if (!success) {
                return false;
            }

            return false;
        }

        return true;

    }

    private async checkDifficulty() {
        if (this.isDestroyed) return;
        // Honor miner's suggested difficulty — do not auto-adjust
        if (this.usedSuggestedDifficulty) return;
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            const oldDiff = this.sessionDifficulty;
            this.sessionDifficulty = targetDiff;

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';


            const success = await this.write(data);
            if (!success) return;

            const jobTemplate = this.stratumV1JobsService.latestJobTemplate;
            if (jobTemplate == null) return;
            await this.sendNewMiningJob({
                ...jobTemplate,
                blockData: {
                    ...jobTemplate.blockData,
                    clearJobs: true
                }
            });

        }
    }

    private validateHeaderCompliance(userAgent: string): boolean {
        const headerCompliance = this.configService.get<string>('COMPLIANT_HEADERS');
        if (!headerCompliance || headerCompliance.trim() === '') {
            return false;
        }

        const complianceList = headerCompliance.split(',').map(ua => ua.trim().toLowerCase());
        const userAgentLower = userAgent.toLowerCase();

        // Return true if the user agent is NOT in the compliance list (non-compliant)
        return !complianceList.some(compliant => compliant.length > 0 && userAgentLower.includes(compliant));
    }

    private async write(message: string): Promise<boolean> {
        if (this.isDestroyed) return false;

        try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {

                await new Promise((resolve, reject) => {
                    this.socket.write(message, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(true);
                        }
                    });
                });

                return true;
            } else {
                this.safeDisconnect();
                return false;
            }
        } catch (error: any) {
            // EPIPE/ECONNRESET are expected when miners disconnect — don't flood logs
            const code = error.code || '';
            if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'ERR_STREAM_DESTROYED') {
                console.error(`Socket write error [${this.extraNonceAndSessionId}]: ${code || error.message}`);
            }
            this.safeDisconnect();
            return false;
        }
    }

}
