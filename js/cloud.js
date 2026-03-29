/**
 * cloud.js — CloudManager: save/load projects and sample library via Supabase.
 *
 * ── SQL to run once in your Supabase SQL Editor ───────────────────────────────
 *
 * -- Projects metadata table
 * create table if not exists projects (
 *   id          uuid primary key default gen_random_uuid(),
 *   user_id     uuid references auth.users not null,
 *   name        text not null default 'Untitled',
 *   storage_path text not null,
 *   size_bytes  int,
 *   updated_at  timestamptz default now()
 * );
 * alter table projects enable row level security;
 * create policy "own projects" on projects for all using (auth.uid() = user_id);
 *
 * -- Sample library metadata table
 * create table if not exists samples (
 *   id           uuid primary key default gen_random_uuid(),
 *   user_id      uuid references auth.users not null,
 *   name         text not null,
 *   storage_path text not null,
 *   duration_s   float,
 *   created_at   timestamptz default now()
 * );
 * alter table samples enable row level security;
 * create policy "own samples" on samples for all using (auth.uid() = user_id);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage buckets (create in Supabase Dashboard → Storage):
 *   "projects"  → private
 *   "samples"   → private
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { audioBufferToWAV } from './wav-utils.js';

export class CloudManager {
  constructor(supabase, auth, engine) {
    this._sb     = supabase;   // null if not configured
    this._auth   = auth;
    this._engine = engine;
  }

  get ready()     { return !!this._sb && this._auth.isLoggedIn; }
  get configured(){ return !!this._sb; }

  // ── Projects ──────────────────────────────────────────────────────────────

  /** Upload JSON string as a project; returns the project id */
  async saveProject(name, jsonString) {
    this._assertReady();
    const userId   = this._auth.userId;
    const blob     = new Blob([jsonString], { type: 'application/json' });

    // Check if a project with the same name already exists → reuse its id
    const { data: existing } = await this._sb
      .from('projects')
      .select('id, storage_path')
      .eq('user_id', userId)
      .eq('name', name)
      .maybeSingle();

    const projectId   = existing?.id ?? crypto.randomUUID();
    const storagePath = `${userId}/${projectId}.json`;

    // Remove old file if it exists (upsert on Storage doesn't overwrite metadata)
    if (existing?.storage_path) {
      await this._sb.storage.from('projects').remove([existing.storage_path]);
    }

    const { error: uploadErr } = await this._sb.storage
      .from('projects')
      .upload(storagePath, blob, { contentType: 'application/json', upsert: true });
    if (uploadErr) throw uploadErr;

    const { error: dbErr } = await this._sb.from('projects').upsert({
      id:           projectId,
      user_id:      userId,
      name,
      storage_path: storagePath,
      size_bytes:   blob.size,
      updated_at:   new Date().toISOString(),
    });
    if (dbErr) throw dbErr;

    return projectId;
  }

  /** Returns array of { id, name, updated_at, size_bytes } */
  async listProjects() {
    this._assertReady();
    const { data, error } = await this._sb
      .from('projects')
      .select('id, name, updated_at, size_bytes')
      .eq('user_id', this._auth.userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  /** Download and return the parsed project JSON object */
  async loadProject(projectId) {
    this._assertReady();
    const { data: meta, error: metaErr } = await this._sb
      .from('projects')
      .select('storage_path')
      .eq('id', projectId)
      .single();
    if (metaErr) throw metaErr;

    const { data: blob, error: dlErr } = await this._sb.storage
      .from('projects')
      .download(meta.storage_path);
    if (dlErr) throw dlErr;

    const text = await blob.text();
    return JSON.parse(text);
  }

  async deleteProject(projectId) {
    this._assertReady();
    const { data: meta } = await this._sb
      .from('projects')
      .select('storage_path')
      .eq('id', projectId)
      .maybeSingle();
    if (meta?.storage_path) {
      await this._sb.storage.from('projects').remove([meta.storage_path]);
    }
    await this._sb.from('projects').delete().eq('id', projectId);
  }

  async renameProject(projectId, newName) {
    this._assertReady();
    await this._sb.from('projects')
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq('id', projectId);
  }

  // ── Samples library ───────────────────────────────────────────────────────

  /** Upload an AudioBuffer as a WAV to the sample library */
  async uploadSample(name, audioBuffer) {
    this._assertReady();
    const userId   = this._auth.userId;
    const sampleId = crypto.randomUUID();
    const path     = `${userId}/${sampleId}.wav`;
    const wavBuf   = audioBufferToWAV(audioBuffer);
    const blob     = new Blob([wavBuf], { type: 'audio/wav' });

    const { error: uploadErr } = await this._sb.storage
      .from('samples')
      .upload(path, blob, { contentType: 'audio/wav' });
    if (uploadErr) throw uploadErr;

    const { data, error: dbErr } = await this._sb.from('samples').insert({
      user_id:      userId,
      name,
      storage_path: path,
      duration_s:   audioBuffer.duration,
    }).select().maybeSingle();
    if (dbErr) throw dbErr;

    return data;
  }

  /** Returns array of { id, name, duration_s, storage_path, created_at } */
  async listSamples() {
    this._assertReady();
    const { data, error } = await this._sb
      .from('samples')
      .select('id, name, duration_s, storage_path, created_at')
      .eq('user_id', this._auth.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  /** Download a sample from the library, decode, and return an AudioBuffer */
  async downloadSample(storagePath) {
    this._assertReady();
    if (!this._engine.ctx) this._engine.init();
    const { data: blob, error } = await this._sb.storage
      .from('samples')
      .download(storagePath);
    if (error) throw error;
    const arrayBuffer = await blob.arrayBuffer();
    return this._engine.ctx.decodeAudioData(arrayBuffer);
  }

  async deleteSample(sampleId) {
    this._assertReady();
    const { data: meta } = await this._sb
      .from('samples')
      .select('storage_path')
      .eq('id', sampleId)
      .maybeSingle();
    if (meta?.storage_path) {
      await this._sb.storage.from('samples').remove([meta.storage_path]);
    }
    await this._sb.from('samples').delete().eq('id', sampleId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _assertReady() {
    if (!this._sb) throw new Error('Supabase not configured — fill in js/config.js');
    if (!this._auth.isLoggedIn) throw new Error('Not signed in');
  }
}
