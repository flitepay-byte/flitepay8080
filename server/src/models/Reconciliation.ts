import { Schema, model, type Document, type Types } from 'mongoose';
import { RECON_RESULTS, type ReconResult } from '../types';

export interface IReconciliationEntry {
  reference: string;
  systemAmountPaise: number | null;
  statementAmountPaise: number | null;
  differencePaise: number | null;
  taskId?: Types.ObjectId | null;
  taskCode?: string | null;
  result: ReconResult;
  note?: string;
}

export interface IReconciliationRun extends Document {
  _id: Types.ObjectId;
  runCode: string;
  uploadedBy: Types.ObjectId;
  originalFileName: string;
  totalStatementRows: number;
  matchedCount: number;
  discrepancyCount: number;
  unmatchedStatementCount: number;
  unmatchedSystemCount: number;
  entries: IReconciliationEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const entrySchema = new Schema<IReconciliationEntry>(
  {
    reference: { type: String, required: true },
    systemAmountPaise: { type: Number, default: null },
    statementAmountPaise: { type: Number, default: null },
    differencePaise: { type: Number, default: null },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    taskCode: { type: String, default: null },
    result: { type: String, enum: RECON_RESULTS, required: true },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const reconSchema = new Schema<IReconciliationRun>(
  {
    runCode: { type: String, required: true, unique: true, uppercase: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalFileName: { type: String, required: true },
    totalStatementRows: { type: Number, default: 0, min: 0 },
    matchedCount: { type: Number, default: 0, min: 0 },
    discrepancyCount: { type: Number, default: 0, min: 0 },
    unmatchedStatementCount: { type: Number, default: 0, min: 0 },
    unmatchedSystemCount: { type: Number, default: 0, min: 0 },
    entries: { type: [entrySchema], default: [] },
  },
  { timestamps: true },
);

reconSchema.index({ createdAt: -1 });

export const ReconciliationRun = model<IReconciliationRun>('ReconciliationRun', reconSchema);
