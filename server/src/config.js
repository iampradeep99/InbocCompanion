export function serverConfig(env = process.env) {
  const port = Number(env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const host = env.HOST || (env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
  const publicUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  const allowedHosts = ['127.0.0.1', 'localhost'];
  let origin = `http://127.0.0.1:${port}`;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_URL must be an HTTPS origin, such as https://inbox.onrender.com.');
    }
    origin = url.origin;
    allowedHosts.push(url.hostname);
  }
  return { port, host, allowedHosts, redirectUri: env.GOOGLE_REDIRECT_URI || `${origin}/auth/google/callback` };
}
