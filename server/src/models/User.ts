import { Schema, model, type Document, type Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES, type Role } from '../types';

export interface IUser extends Document {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  failedLoginAttempts: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
  isLocked(): boolean;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
    role: { type: String, required: true, enum: ROLES, index: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true },
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.index({ role: 1, status: 1 });

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.methods.isLocked = function (): boolean {
  return Boolean(this.lockedUntil && this.lockedUntil.getTime() > Date.now());
};

/** Never leak the hash, even if a caller forgets `.select('-passwordHash')`. */
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const plain = ret as unknown as Record<string, unknown>;
    delete plain['passwordHash'];
    delete plain['__v'];
    return plain;
  },
});

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export const User = model<IUser>('User', userSchema);
