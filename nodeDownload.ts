import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import { pipeline } from "stream/promises";

interface DownloadOptions {
	md5?: string | null;
	maxRetries?: number;
	timeout?: number;
	onProgress?: (downloaded: number, total: number, speed: number) => void;
}

/**
 * 下载文件并支持断点续传、MD5校验及实时速度回调
 * @param {string} url - 文件的远程下载地址
 * @param {string} destFilePath - 文件保存到本地的绝对路径
 * @param {DownloadOptions} [options={}] - 下载配置选项
 * @param {string | null} [options.md5=null] - 预期的文件 MD5 哈希值，用于下载完成后校验文件完整性
 * @param {number} [options.maxRetries=5] - 下载失败后的最大重试次数
 * @param {number} [options.timeout=15000] - 下载响应超时时间（单位：毫秒），最小值为 15000
 * @param {function} [options.onProgress] - 下载进度与实时速度的回调函数
 * @param {number} options.onProgress.downloaded - 当前已下载的字节数
 * @param {number} options.onProgress.total - 文件总字节数
 * @param {number} options.onProgress.speed - 实时下载速度（单位：字节/秒）
 * @returns {Promise<string>} 返回一个 Promise，解析为下载完成后的本地文件绝对路径
 */
async function downloadFile(url: string, destFilePath: string, options: DownloadOptions): Promise<string> {
	const { md5 = null, onProgress = null, timeout = 15000, maxRetries = 5 } = options;
	const finalTimeout = Math.max(15000, timeout!);
	const finalMaxRetries = Math.max(1, maxRetries!);
	const destDir = path.dirname(destFilePath);
	const tmpFilePath = `${destFilePath}.tmp`;
	const calculateFileMd5 = async (filePath: string): Promise<string | null> => {
		try {
			await fs.access(filePath);
		} catch {
			return null;
		}
		return new Promise((resolve, reject) => {
			const hash = crypto.createHash("md5");
			const stream = createReadStream(filePath);
			stream.on("data", data => hash.update(data));
			stream.on("end", () => resolve(hash.digest("hex")));
			stream.on("error", err => reject(err));
		});
	};

	// 辅助函数：获取远程文件大小（带超时控制）
	const getRemoteFileSize = async (url: string): Promise<number> => {
		return new Promise(resolve => {
			const client = url.startsWith("https://") ? https : http;
			const options = { method: "HEAD", timeout: finalTimeout };
			const req = client.request(url, options, res => {
				if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
					resolve(parseInt(res.headers["content-length"] || "0", 10));
				} else {
					const getReq = client.get(url, { timeout: finalTimeout }, getRes => {
						getRes.resume();
						resolve(parseInt(getRes.headers["content-length"] || "0", 10));
					});
					getReq.on("error", () => resolve(0));
				}
			});
			req.on("error", () => resolve(0));
			req.on("timeout", () => {
				req.destroy();
				resolve(0);
			});
			req.end();
		});
	};

	// 核心下载逻辑
	const sendDownload = async (tmpFilePath: string, retryCount: number): Promise<void> => {
		let req: http.ClientRequest | null = null;
		let fileStream: ReturnType<typeof createWriteStream> | null = null;
		let progressTimer: NodeJS.Timeout | null = null;
		let isValidationError = false;
		try {
			let downloadedBytes = 0;
			try {
				downloadedBytes = (await fs.stat(tmpFilePath)).size;
			} catch {
				downloadedBytes = 0;
			}
			const client = url.startsWith("https://") ? https : http;
			const headers: http.OutgoingHttpHeaders = {};
			if (downloadedBytes > 0) headers["Range"] = `bytes=${downloadedBytes}-`;
			await new Promise<void>((resolve, reject) => {
				req = client.get(url, { headers, timeout: finalTimeout }, res => {
					if (res.statusCode === 200 && downloadedBytes > 0) {
						return reject(new Error("SERVER_NO_RANGE"));
					}
					if (res.statusCode === undefined || (res.statusCode !== 200 && res.statusCode !== 206)) {
						return reject(new Error(`服务器响应失败，状态码: ${res.statusCode}`));
					}
					const chunkLength = parseInt(res.headers["content-length"] || "0", 10);
					let totalBytes = chunkLength;
					if (res.statusCode === 206) totalBytes += downloadedBytes;
					let currentProgress = downloadedBytes;
					let lastTime = Date.now();
					let lastLoaded = downloadedBytes;
					const REPORT_INTERVAL = 250;
					let lastTimeoutResetTime = Date.now();
					fileStream = createWriteStream(tmpFilePath, { flags: downloadedBytes > 0 ? "a" : "w" });
					const emitProgress = () => {
						if (!onProgress) return;
						const now = Date.now();
						const timeDiff = (now - lastTime) / 1000;
						if (timeDiff > 0 && currentProgress > lastLoaded) {
							const speed = (currentProgress - lastLoaded) / Math.max(timeDiff, 0.001);
							onProgress(currentProgress, totalBytes, speed);
							lastTime = now;
							lastLoaded = currentProgress;
						}
					};
					res.on("data", (chunk: Buffer) => {
						currentProgress += chunk.length;
						const now = Date.now();
						if (now - lastTimeoutResetTime >= 1000) {
							req?.setTimeout(finalTimeout);
							lastTimeoutResetTime = now;
						}
					});
					progressTimer = setInterval(emitProgress, REPORT_INTERVAL);
					pipeline(res, fileStream)
						.then(async () => {
							if (progressTimer) clearInterval(progressTimer);
							emitProgress();
							if (md5 && !tmpFilePath.includes(".manifest")) {
								const calculatedMd5 = await calculateFileMd5(tmpFilePath);
								if (calculatedMd5 && calculatedMd5.toLowerCase() !== md5.toLowerCase()) {
									isValidationError = true;
									req?.destroy();
									return reject(new Error(`MD5 校验不匹配！预期: ${md5}, 计算出: ${calculatedMd5}`));
								}
							} else if (totalBytes && currentProgress !== totalBytes) {
								isValidationError = true;
								req?.destroy();
								return reject(
									new Error(`文件完整性校验失败：预期大小 ${totalBytes}，实际下载 ${currentProgress}`),
								);
							}
							resolve();
						})
						.catch(err => {
							if (progressTimer) clearInterval(progressTimer);
							reject(err);
						});
				});
				req.on("error", err => reject(err));
				req.on("timeout", () => {
					req?.destroy();
					fileStream?.destroy();
					reject(new Error(`下载响应超时：超过 ${finalTimeout}ms 未接收到新数据`));
				});
			});
		} catch (error: any) {
			if (progressTimer) clearInterval(progressTimer);
			if (error.message === "SERVER_NO_RANGE" || isValidationError) {
				try {
					await fs.unlink(tmpFilePath);
				} catch {}
			}
			if (retryCount < finalMaxRetries) {
				const nextRetry = retryCount + 1;
				const delay = nextRetry * 200;
				console.log(`下载出错 (${error.message})，${delay}ms 后进行第 ${nextRetry} 次重试...`);
				await new Promise(r => setTimeout(r, delay));
				return sendDownload(tmpFilePath, nextRetry);
			} else {
				try {
					await fs.unlink(tmpFilePath);
				} catch {}
				throw new Error(`${new URL(url).pathname} 下载失败，已达最大重试次数。原因：${error.message}`);
			}
		}
	};

	await fs.mkdir(destDir, { recursive: true });
	try {
		const stats = await fs.stat(destFilePath);
		if (md5 && !url.includes(".manifest")) {
			const localMd5 = await calculateFileMd5(destFilePath);
			if (localMd5 && localMd5.toLowerCase() === md5.toLowerCase()) {
				onProgress?.(stats.size, stats.size, 0);
				return destFilePath;
			}
		} else {
			const remoteSize = await getRemoteFileSize(url);
			if (remoteSize > 0 && stats.size === remoteSize) {
				onProgress?.(stats.size, stats.size, 0);
				return destFilePath;
			}
		}
	} catch {}
	await sendDownload(tmpFilePath, 0);
	try {
		await fs.unlink(destFilePath);
	} catch {}
	await fs.rename(tmpFilePath, destFilePath);
	return destFilePath;
}
