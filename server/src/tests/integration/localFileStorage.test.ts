/**
 * Uploads without Cloudinary.
 *
 * Refusing the upload was the wrong failure. Every flow in the app worked
 * without Cloudinary credentials right up to the moment somebody attached a
 * receipt, and then they got "File storage is not configured" — which reads as
 * a broken app, not a missing optional credential. And a receipt is not an
 * optional nicety: it is how a party and a captain settle an argument about
 * real money, so losing it is worse than storing it somewhere less durable.
 *
 * Cloudinary is stubbed out below rather than assumed absent: a developer with
 * working credentials in their .env would otherwise skip straight past the very
 * path these tests exist to cover, and the suite would pass by not running.
 */
// Force the fallback on regardless of what the local .env holds.
jest.mock('../../config/cloudinary', () => ({
  isCloudinaryConfigured: () => false,
  getCloudinary: () => {
    throw new Error('Cloudinary must not be reached when it is not configured');
  },
}));

import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { describeIntegration, setupDatabase, teardownDatabase } from '../setup';
import { uploadFile, deleteFile, storageBackend, LOCAL_UPLOAD_DIR } from '../../services/storage.service';
import { createApp } from '../../app';

describeIntegration('uploads when Cloudinary is not configured', () => {
  const app = createApp();
  const written: string[] = [];

  beforeAll(setupDatabase);
  afterAll(async () => {
    // Only the files these tests made — never the whole directory, which may
    // hold a developer's real uploads.
    for (const name of written) {
      await rm(path.join(LOCAL_UPLOAD_DIR, name), { force: true });
    }
    await teardownDatabase();
  });

  const track = (publicId: string): string => {
    const name = publicId.replace(/^local:/, '');
    written.push(name);
    return name;
  };

  it('falls back to local disk rather than refusing', async () => {
    expect(storageBackend()).toBe('local');

    const stored = await uploadFile(Buffer.from('a receipt'), 'image/png');
    const name = track(stored.publicId);

    expect(stored.publicId.startsWith('local:')).toBe(true);
    expect(stored.url).toBe(`/uploads/${name}`);
    // The bytes are really on disk, not merely promised.
    expect((await readFile(path.join(LOCAL_UPLOAD_DIR, name))).toString()).toBe('a receipt');
  });

  it('keeps the extension so the file opens as what it is', async () => {
    const png = await uploadFile(Buffer.from('x'), 'image/png');
    const pdf = await uploadFile(Buffer.from('y'), 'application/pdf');
    const jpg = await uploadFile(Buffer.from('z'), 'image/jpeg');
    [png, pdf, jpg].forEach((f) => track(f.publicId));

    expect(png.url.endsWith('.png')).toBe(true);
    expect(pdf.url.endsWith('.pdf')).toBe(true);
    expect(jpg.url.endsWith('.jpg')).toBe(true);
  });

  it('never reuses a name, even for identical files', async () => {
    const a = await uploadFile(Buffer.from('same bytes'), 'image/png');
    const b = await uploadFile(Buffer.from('same bytes'), 'image/png');
    track(a.publicId);
    track(b.publicId);

    // Two people uploading the same screenshot must not overwrite each other,
    // and must not be able to find each other's by guessing.
    expect(a.publicId).not.toBe(b.publicId);
    expect(await readFile(path.join(LOCAL_UPLOAD_DIR, a.publicId.slice(6)), 'utf8')).toBe('same bytes');
    expect(await readFile(path.join(LOCAL_UPLOAD_DIR, b.publicId.slice(6)), 'utf8')).toBe('same bytes');
  });

  it('serves what it stored', async () => {
    const stored = await uploadFile(Buffer.from('served bytes'), 'image/png');
    track(stored.publicId);

    const res = await request(app).get(stored.url);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('served bytes');
  });

  it('404s a file that does not exist', async () => {
    const res = await request(app).get('/uploads/nothing-here.png');
    expect(res.status).toBe(404);
  });

  it('deletes a local file when the surrounding request fails', async () => {
    const stored = await uploadFile(Buffer.from('orphan'), 'image/png');
    const name = stored.publicId.slice('local:'.length);

    await deleteFile(stored.publicId, 'image/png');

    // Gone, so a failed request does not leave its upload behind forever.
    await expect(stat(path.join(LOCAL_UPLOAD_DIR, name))).rejects.toThrow();
  });

  it('refuses to delete outside its own directory', async () => {
    // A public id is ours, never a user's, so a traversal in one is a bug or an
    // attack. Either way it must not be quietly worked around.
    await expect(deleteFile('local:../../package.json')).resolves.toBeUndefined();
    await expect(stat(path.resolve(process.cwd(), 'package.json'))).resolves.toBeDefined();
  });

  it('does not throw when deleting something already gone', async () => {
    // Cleanup runs on failure paths, where the file may never have been
    // written. Throwing there would replace the real error with this one.
    await expect(deleteFile('local:not-a-real-file.png')).resolves.toBeUndefined();
  });
});
