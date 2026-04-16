import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { HomeGraphService } from '../ORM/home-graph/home-graph.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly rpcBlockService: RpcBlockService,
        private readonly homeGraphService: HomeGraphService,
        private readonly dataSource: DataSource,
        private readonly userAgentReportService: UserAgentReportService
    ) {

    }

    async onModuleInit() {

        const processTag = process.env.MASTER === 'true' ? '[Master]' : `[Worker:${process.pid}]`;
        console.log(`${processTag} AppService initialized`);

        if (process.env.MASTER == 'true') {

            setInterval(async () => {
                try {
                    await this.deleteOldStatistics();
                } catch (e: any) {
                    console.error(`${processTag} deleteOldStatistics error: ${e.message}`);
                }
            }, 1000 * 60 * 60);

            setInterval(async () => {
                try {
                    console.log(`${processTag} Killing dead clients`);
                    let rounds = 0;
                    while (await this.clientService.killDeadClients()) {
                        rounds++;
                    }
                    console.log(`${processTag} Finished killing clients (${rounds} rounds)`);
                } catch (e: any) {
                    console.error(`${processTag} killDeadClients error: ${e.message}`);
                }
            }, 1000 * 60 * 5);

            setInterval(async () => {
                try {
                    console.log(`${processTag} Deleting old blocks`);
                    await this.rpcBlockService.deleteOldBlocks();
                } catch (e: any) {
                    console.error(`${processTag} deleteOldBlocks error: ${e.message}`);
                }
            }, 1000 * 60 * 60 * 24);

            setInterval(async () => {
                try {
                    await this.updateChart();
                } catch (e: any) {
                    console.error(`${processTag} updateChart error: ${e.message}`);
                }
            }, 1000 * 60 * 10);

            setInterval(async () => {
                try {
                    console.log(`${processTag} Refreshing user agent report view`);
                    await this.userAgentReportService.refreshReport();
                    console.log(`${processTag} Finished refreshing user agent report view`);
                } catch (e: any) {
                    console.error(`${processTag} refreshReport error: ${e.message}`);
                }
            }, 1000 * 60 * 5);

        }

        // Stagger bulk DB operations to avoid connection pool contention
        // Stats at 0s, heartbeat at 15s offset within each 30s cycle
        setInterval(async () => {
            try {
                await this.clientStatisticsService.doBulkAsyncUpdate();
            } catch (e: any) {
                console.error(`${processTag} doBulkAsyncUpdate error: ${e.message}`);
            }
        }, 1000 * 30);

        setTimeout(() => {
            setInterval(async () => {
                try {
                    await this.clientService.doBulkHeartbeatUpdate();
                } catch (e: any) {
                    console.error(`${processTag} doBulkHeartbeatUpdate error: ${e.message}`);
                }
            }, 1000 * 30);
        }, 15000);

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
        console.log(`Deleted ${deletedStatistics.affected} old statistics`);
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


    private async updateChart() {
        console.log('Updating Chart');

        const latestGraphUpdate = await this.homeGraphService.getLatestTime();


        const data = await this.dataSource.query(`
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > $1
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `, [latestGraphUpdate.getTime()])

        console.log(`Fetched ${data.length} chart rows`);

        if (data.length < 2) {
            return;
        }

        const result = data.slice(0, data.length - 1);

        try {
            await this.homeGraphService.save(result);
        } catch (e: any) {
            console.error(`Chart save error: ${e.message}`);
        }

    }
}
