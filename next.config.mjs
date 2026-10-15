/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["falkordb", "@redis/client"],
};
export default nextConfig;
