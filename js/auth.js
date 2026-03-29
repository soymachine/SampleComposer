/**
 * auth.js — AuthManager wrapping Supabase Auth.
 * Handles email/password + Google OAuth, session persistence, and state changes.
 */
export class AuthManager {
  constructor(supabase) {
    this._sb      = supabase;  // may be null if not configured
    this.user     = null;
    this.onAuthChange = null;  // (user | null) => void
  }

  async init() {
    if (!this._sb) return;
    const { data: { session } } = await this._sb.auth.getSession();
    this.user = session?.user ?? null;
    this._sb.auth.onAuthStateChange((_, session) => {
      this.user = session?.user ?? null;
      if (this.onAuthChange) this.onAuthChange(this.user);
    });
  }

  /** Open Google OAuth popup / redirect */
  async signInWithGoogle() {
    if (!this._sb) throw new Error('Supabase not configured');
    const { error } = await this._sb.auth.signInWithOAuth({
      provider: 'google',
      options:  { redirectTo: window.location.href },
    });
    if (error) throw error;
  }

  async signInWithEmail(email, password) {
    if (!this._sb) throw new Error('Supabase not configured');
    const { data, error } = await this._sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async signUpWithEmail(email, password) {
    if (!this._sb) throw new Error('Supabase not configured');
    const { data, error } = await this._sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async signOut() {
    if (!this._sb) return;
    await this._sb.auth.signOut();
  }

  get isLoggedIn() { return !!this.user; }
  get userId()     { return this.user?.id; }
  get userEmail()  { return this.user?.email; }
  get userInitial(){ return (this.user?.email?.[0] ?? '?').toUpperCase(); }
}
