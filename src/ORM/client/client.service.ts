import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {

    private heartbeatBulkUpdate: { [id: string]: { id: string, hashRate: number, updatedAt: Date } } = {};

    constructor(
        @InjectDataSource()
        private dataSource: DataSource,
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    // client.service.ts
    public async killDeadClients(): Promise<boolean> {
        const BATCH_SIZE = 10000;

        return this.dataSource.transaction('READ COMMITTED', async (manager) => {  // ← CHANGE HERE
            const deadClients: { id: string }[] = await manager.query(`
                SELECT id
                FROM client_entity
                WHERE "deletedAt" IS NULL
                  AND "updatedAt" < NOW() - INTERVAL '5 minutes'
                ORDER BY id
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            `, [BATCH_SIZE]);

            if (deadClients.length === 0) {
                return false;
            }

            await manager
                .createQueryBuilder()
                .update(ClientEntity)
                .set({ deletedAt: () => 'NOW()' })
                .whereInIds(deadClients.map(c => c.id))
                .execute();

            console.log(`Killed ${deadClients.length} dead clients`);

            return true;
        });
    }

    //public async heartbeat(id, hashRate: number, updatedAt: Date) {
    //     return await this.clientRepository.update({ id }, { hashRate, deletedAt: null, updatedAt });
    // }

    public heartbeatBulkAsync(id, hashRate: number, updatedAt: Date) {
        if (this.heartbeatBulkUpdate[id] != null) {
            this.heartbeatBulkUpdate[id].hashRate = hashRate;
            this.heartbeatBulkUpdate[id].updatedAt = updatedAt;
            return;
        }
        this.heartbeatBulkUpdate[id] = { id, hashRate, updatedAt };
    }

    public async doBulkHeartbeatUpdate() {
        if (Object.keys(this.heartbeatBulkUpdate).length < 1) {
            return;
        }

        // Atomically swap the map so new heartbeats go to a fresh map while we flush
        const pending = this.heartbeatBulkUpdate;
        this.heartbeatBulkUpdate = {};
        const entries = Object.values(pending);

        const ids: string[] = [];
        const hashRates: number[] = [];
        const updatedAts: Date[] = [];

        for (const value of entries) {
            if (!value.id || typeof value.hashRate !== 'number' || !Number.isFinite(value.hashRate) || !value.updatedAt) {
                console.warn('Skipping invalid heartbeat bulk update entry', value);
                continue;
            }
            ids.push(value.id);
            hashRates.push(value.hashRate);
            updatedAts.push(value.updatedAt);
        }

        if (ids.length === 0) {
            return;
        }

        const query = `
            UPDATE "client_entity" ce
            SET "hashRate" = th."hashRate",
                "deletedAt" = NULL,
                "updatedAt" = th."updatedAt"
            FROM (
                SELECT unnest($1::uuid[]) as id,
                       unnest($2::decimal[]) as "hashRate",
                       unnest($3::timestamp[]) as "updatedAt"
            ) th
            WHERE ce.id = th.id;
        `;

        try {
            const start = Date.now();
            await this.clientRepository.query(query, [ids, hashRates, updatedAts]);
            console.log(`Bulk heartbeat update: ${ids.length} rows in ${Date.now() - start}ms`);
        } catch (error) {
            console.error(`Bulk heartbeat failed (${ids.length} rows): ${error.message}`);
        }
    }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {
        const insertResult = await this.clientRepository.insert(partialClient);

        const client = {
            ...partialClient,
            ...insertResult.generatedMaps[0]
        };

        return client as ClientEntity;
    }

    public async delete(id: string) {
        return await this.clientRepository.softDelete({ id });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(id: string, bestDifficulty: number) {
        return await this.clientRepository.update({ id }, { bestDifficulty });
    }
    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => 'NOW()' })
            .where('"deletedAt" IS NULL')
            .execute();
    }

    // public async getUserAgents() {
    //     const result = await this.clientRepository.createQueryBuilder('client')
    //         .select('client.userAgent as "userAgent"')
    //         .addSelect('COUNT(client.userAgent)', 'count')
    //         .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
    //         .addSelect('SUM(client.hashRate)', 'totalHashRate')
    //         .groupBy('client.userAgent')
    //         .orderBy('"totalHashRate"', 'DESC')
    //         .getRawMany();
    //     return result;
    // }

}