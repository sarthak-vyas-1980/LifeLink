// Keep framework configuration separate from application behavior.
const apiOrigin = (process.env.API_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const nextConfig = {
	async rewrites() {
		return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
	},
};

export default nextConfig;
