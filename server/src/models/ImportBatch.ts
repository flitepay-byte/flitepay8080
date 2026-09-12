import { Schema, model, type Document, type Types } from 'mongoose';

export interface IImportRowError {
  rowNumber: number;
  field: string;
  message: string;
  rawValue?: string;
}

export interface IImportBatch extends Document {
  _id: Types.ObjectId;
  batchCode: string;
  partyId: Types.ObjectId;
  uploadedBy: Types.ObjectId;
  originalFileName: string;
  status: 'PREVIEW' | 'IMPORTED' | 'DISCARDED';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  rowErrors: IImportRowError[];
  /** Parsed valid rows held for the confirm step. */
  stagedRows: unknown[];
  importedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const importErrorSchema = new Schema<IImportRowError>(
  {
    rowNumber: { type: Number, required: true },
    field: { type: String, required: true },
    message: { type: String, required: true },
    rawValue: { type: String },
  },
  { _id: false },
);

const importBatchSchema = new Schema<IImportBatch>(
  {
    batchCode: { type: String, required: true, unique: true, uppercase: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalFileName: { type: String, required: true },
    status: { type: String, enum: ['PREVIEW', 'IMPORTED', 'DISCARDED'], default: 'PREVIEW', index: true },
    totalRows: { type: Number, default: 0, min: 0 },
    validRows: { type: Number, default: 0, min: 0 },
    invalidRows: { type: Number, default: 0, min: 0 },
    duplicateRows: { type: Number, default: 0, min: 0 },
    importedRows: { type: Number, default: 0, min: 0 },
    rowErrors: { type: [importErrorSchema], default: [] },
    stagedRows: { type: [Schema.Types.Mixed], default: [] },
    importedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

importBatchSchema.index({ partyId: 1, createdAt: -1 });

export const ImportBatch = model<IImportBatch>('ImportBatch', importBatchSchema);
