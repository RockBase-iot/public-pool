import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    private bulkAsyncUpdates: {
        [key: string]: Partial<ClientStatisticsEntity>
    } = {};

    constructor(

        @InjectDataSource()
        private dataSource: DataSource,
        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    public updateBulkAsync(clientStatistic: Partial<ClientStatisticsEntity>) {
        const key = clientStatistic.clientId + clientStatistic.time.toString();
        if (this.bulkAsyncUpdates[key] != null) {
            this.bulkAsyncUpdates[key].shares = clientStatistic.shares;
            this.bulkAsyncUpdates[key].acceptedCount = clientStatistic.acceptedCount;
            return;
        }

        this.bulkAsyncUpdates[clientStatistic.clientId + clientStatistic.time.toString()] = clientStatistic;
    }

    public async doBulkAsyncUpdate() {
        if (Object.keys(this.bulkAsyncUpdates).length < 1) {
            return;
        }

        // Atomically swap the map so new updates go to a fresh map while we flush
        const pending = this.bulkAsyncUpdates;
        this.bulkAsyncUpdates = {};
        const entries = Object.values(pending);

        const clientIds: string[] = [];
        const times: number[] = [];
        const sharesArr: number[] = [];
        const acceptedCounts: number[] = [];
        const addresses: string[] = [];
        const clientNames: string[] = [];
        const sessionIds: string[] = [];

        for (const value of entries) {
            if (!value.clientId || typeof value.time !== 'number' || !Number.isFinite(value.time) ||
                typeof value.shares !== 'number' || !Number.isFinite(value.shares) ||
                typeof value.acceptedCount !== 'number' || !Number.isInteger(value.acceptedCount) ||
                !value.address || !value.sessionId) {
                console.warn('Skipping invalid statistics bulk upsert entry', value);
                continue;
            }
            clientIds.push(value.clientId);
            times.push(value.time);
            sharesArr.push(value.shares);
            acceptedCounts.push(value.acceptedCount);
            addresses.push(value.address);
            clientNames.push(value.clientName || '');
            sessionIds.push(value.sessionId);
        }

        if (clientIds.length === 0) {
            return;
        }

        // UPSERT: INSERT new rows or UPDATE existing ones in a single batch
        const query = `
            INSERT INTO "client_statistics_entity" ("clientId", "time", "shares", "acceptedCount", "address", "clientName", "sessionId", "createdAt", "updatedAt")
            SELECT unnest($1::uuid[]) AS "clientId",
                   unnest($2::bigint[]) AS "time",
                   unnest($3::numeric[]) AS "shares",
                   unnest($4::int[]) AS "acceptedCount",
                   unnest($5::varchar[]) AS "address",
                   unnest($6::varchar[]) AS "clientName",
                   unnest($7::varchar[]) AS "sessionId",
                   NOW() AS "createdAt",
                   NOW() AS "updatedAt"
            ON CONFLICT ("clientId", "time")
            DO UPDATE SET
                "shares" = EXCLUDED."shares",
                "acceptedCount" = EXCLUDED."acceptedCount",
                "updatedAt" = NOW();
        `;

        try {
            const start = Date.now();
            await this.clientStatisticsRepository.query(query, [clientIds, times, sharesArr, acceptedCounts, addresses, clientNames, sessionIds]);
            console.log(`Bulk stats upsert: ${clientIds.length} rows in ${Date.now() - start}ms`);
        } catch (error: any) {
            console.error(`Bulk stats upsert failed (${clientIds.length} rows): ${error.message}`);
        }
    }

    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        await this.clientStatisticsRepository.insert(clientStatistic);
    }

    public async deleteOldStatistics() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }



    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    time AS label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = $1 AND entry.time > $2
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

        const result = await this.clientStatisticsRepository.query(query, [address, yesterday.getTime()]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry.clientName = $2 AND entry.time > $3
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, oneHour.getTime()]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry."clientName" = $2 AND entry.time > $3
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, yesterday.getTime()]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getChartDataForSession(clientId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."clientId" = $1 AND entry.time > $2
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [clientId, yesterday.getTime()]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}
