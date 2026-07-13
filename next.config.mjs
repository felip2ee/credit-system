/** @type {import('next').NextConfig} */
const nextConfig = {
  // Gera .next/standalone (server.js + só as deps usadas) — a imagem Docker
  // final fica pequena e não precisa do node_modules completo.
  output: "standalone",
};

export default nextConfig;
