import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  ensureSourceHtmlBlob,
  ensureSourceHtmlBlobs,
  sourceHtmlContentHash,
} from '@/server/documents/html-storage';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('concurrent transactions resolve one canonical HTML blob', async () => {
  const html = `<section data-test="${randomUUID()}">동일 HTML</section>`;
  const hash = createHash('sha256').update(html).digest('hex');
  const firstClient = await db.connect();
  const secondClient = await db.connect();
  let firstOpen = false;
  let secondOpen = false;

  try {
    await firstClient.query('begin');
    firstOpen = true;
    await secondClient.query('begin');
    secondOpen = true;

    const firstId = await ensureSourceHtmlBlob(firstClient, html);
    const secondInsert = ensureSourceHtmlBlob(secondClient, html);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await firstClient.query('commit');
    firstOpen = false;
    const secondId = await secondInsert;
    await secondClient.query('commit');
    secondOpen = false;

    expect(secondId).toBe(firstId);
    const stored = await db.query<{
      id:string;
      html:string;
      byte_size:string;
    }>(
      `select id,html,byte_size
         from source_html_blobs
        where content_hash=$1`,
      [hash],
    );
    expect(stored.rows).toEqual([{
      id:firstId,
      html,
      byte_size:String(Buffer.byteLength(html, 'utf8')),
    }]);
  } finally {
    if (firstOpen) await firstClient.query('rollback').catch(() => undefined);
    if (secondOpen) await secondClient.query('rollback').catch(() => undefined);
    firstClient.release();
    secondClient.release();
  }
});

test('inverse ordered HTML sets acquire canonical blobs without deadlocking', async () => {
  const marker = randomUUID();
  const htmlA = `<section data-test="${marker}-a">HTML A</section>`;
  const htmlB = `<section data-test="${marker}-b">HTML B</section>`;
  const hashA = sourceHtmlContentHash(htmlA);
  const hashB = sourceHtmlContentHash(htmlB);
  const firstClient = await db.connect();
  const secondClient = await db.connect();
  let firstOpen = false;
  let secondOpen = false;

  await db.query(`
    create or replace function test_pause_inverse_html_blob_insert()
    returns trigger language plpgsql as $$
    begin
      if new.content_hash in ('${hashA}', '${hashB}') then
        perform pg_sleep(0.2);
      end if;
      return new;
    end;
    $$;
    drop trigger if exists test_pause_inverse_html_blob_insert
      on source_html_blobs;
    create trigger test_pause_inverse_html_blob_insert
    after insert on source_html_blobs
    for each row execute function test_pause_inverse_html_blob_insert();
  `);

  try {
    await firstClient.query('begin');
    firstOpen = true;
    await secondClient.query('begin');
    secondOpen = true;

    const firstAcquisition = ensureSourceHtmlBlobs(
      firstClient,
      [htmlA, htmlB],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondAcquisition = ensureSourceHtmlBlobs(
      secondClient,
      [htmlB, htmlA],
    );

    const firstIds = await firstAcquisition;
    await firstClient.query('commit');
    firstOpen = false;
    const secondIds = await secondAcquisition;
    await secondClient.query('commit');
    secondOpen = false;

    expect([...firstIds.keys()]).toEqual([hashA, hashB].sort());
    expect(secondIds.get(hashA)).toBe(firstIds.get(hashA));
    expect(secondIds.get(hashB)).toBe(firstIds.get(hashB));
  } finally {
    if (firstOpen) await firstClient.query('rollback').catch(() => undefined);
    if (secondOpen) await secondClient.query('rollback').catch(() => undefined);
    firstClient.release();
    secondClient.release();
    await db.query(`
      drop trigger if exists test_pause_inverse_html_blob_insert
        on source_html_blobs;
      drop function if exists test_pause_inverse_html_blob_insert();
    `).catch(() => undefined);
  }
});
