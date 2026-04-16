import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueClientStatisticsIndex implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Remove potential duplicates (keep the row with the highest id)
        await queryRunner.query(`
            DELETE FROM "client_statistics_entity" a
            USING "client_statistics_entity" b
            WHERE a."clientId" = b."clientId" AND a."time" = b."time"
            AND a.id < b.id
        `);

        await queryRunner.query(
            `CREATE UNIQUE INDEX "IDX_unique_client_time" ON "client_statistics_entity" ("clientId", "time")`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_unique_client_time"`);
    }

}
