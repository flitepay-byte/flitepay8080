import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * DEMO CUSTOMER — the fictional beneficiary of a Task.
 *
 * `identifier` is the stable key: creating a task with an identifier that
 * already belongs to a customer links to that same record rather than
 * spawning a duplicate, so one Customer can genuinely have many Tasks. Task
 * still keeps its own `customerName`/`identifier` snapshot (audit trail: what
 * the task recorded at creation time should never drift if the customer
 * record is edited later), with `customerId` as the live relationship.
 */
export interface ICustomer extends Document {
  _id: Types.ObjectId;
  name: string;
  /** Fictional destination handle, e.g. DEMO-UPI-001. Never a real VPA. */
  identifier: string;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<ICustomer>(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    identifier: { type: String, required: true, trim: true, unique: true, maxlength: 120 },
  },
  { timestamps: true },
);

export const Customer = model<ICustomer>('Customer', customerSchema);
