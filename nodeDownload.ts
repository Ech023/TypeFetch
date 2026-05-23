import { download } from "./assets/Script/nodeDownload";

const url = process.argv[2];
const dest = process.argv[3];

if (!url || !dest) {
	console.log("用法: npx tsx test_nodeDownload.ts <url> <destPath>");
	process.exit(1);
}

console.log(`下载: ${url}`);
console.log(`保存: ${dest}\n`);

await download(url, dest, {
	onProgress: (done, total, pct, speed) => {
		const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
		const doneMB = (done / 1024 / 1024).toFixed(2);
		const totalMB = (total / 1024 / 1024).toFixed(2);
		process.stdout.write(`\r[${bar}] ${pct.toFixed(1)}% ${doneMB}/${totalMB}MB ${speed}`);
		if (done === total) process.stdout.write("\n");
	},
});

console.log("下载完成");
