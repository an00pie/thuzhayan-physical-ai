import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxy = {};

  function proxyEndpoint(localPath, endpoint) {
    if (!endpoint) return;
    const upstream = new URL(endpoint);
    proxy[localPath] = {
      target: upstream.origin,
      changeOrigin: true,
      rewrite: () => `${upstream.pathname}${upstream.search}`,
    };
  }

  proxyEndpoint("/api/pad", env.ACCELEROMETER_ENDPOINT_URL);
  proxyEndpoint("/api/fc", env.FC_ENDPOINT_URL);

  return { server: { proxy } };
});
