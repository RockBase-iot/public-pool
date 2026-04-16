import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class RpcBlockEntity {

    @PrimaryColumn()
    blockHeight: number;

    @Column({ type: 'text', nullable: true })
    data?: string;
}