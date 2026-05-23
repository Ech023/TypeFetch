import * as fs from "fs/promises";
import * as fsSync from "fs";
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
async function downloadFile(url: string, destFilePath: string, options: DownloadOptions = {}): Promise<string> {
	const { md5 = null, onProgress = null, timeout = 15000, maxRetries = 5 } = options,
		finalTimeout = Math.max(15000, timeout!),
		finalMaxRetries = Math.max(1, maxRetries!),
		calculateFileMd5 = async (filePath: string): Promise<string | null> => {
			try {
				await fs.access(filePath);
			} catch {
				return null;
			}
			return new Promise((resolve, reject) => {
				const hash = crypto.createHash("md5");
				const stream = fsSync.createReadStream(filePath);
				stream.on("data", data => hash.update(data));
				stream.on("end", () => resolve(hash.digest("hex")));
				stream.on("error", err => reject(err));
			});
		},
		getRemoteFileSize = async (url: string): Promise<number> => {
			return new Promise((resolve, reject) => {
				const client = url.includes("https://") ? https : http;
				const req = client.request(url, { method: "HEAD" }, res => {
					if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
						resolve(parseInt(res.headers["content-length"] || "0", 10));
					} else {
						client
							.get(url, getRes => {
								getRes.resume();
								resolve(parseInt(getRes.headers["content-length"] || "0", 10));
							})
							.on("error", err => reject(err));
					}
				});
				req.on("error", err => reject(err));
				req.end();
			});
		},
		sendDownload = async (tmpFilePath: string, retryCount: number): Promise<void> => {
			try {
				let downloadedBytes = 0;
				try {
					downloadedBytes = (await fs.stat(tmpFilePath)).size;
				} catch {
					downloadedBytes = 0;
				}
				const client = url.includes("https://") ? https : http;
				const headers: http.OutgoingHttpHeaders = {};
				if (downloadedBytes > 0) headers["Range"] = `bytes=${downloadedBytes}-`;
				await new Promise<void>((resolve, reject) => {
					const req = client.get(url, { headers }, res => {
						if (res.statusCode === 200 && downloadedBytes > 0) {
							fileStream?.destroy();
							return reject(new Error("SERVER_NO_RANGE"));
						}
						if (res.statusCode === undefined || (res.statusCode !== 200 && res.statusCode !== 206)) {
							return reject(new Error(`服务器响应失败，状态码: ${res.statusCode}`));
						}
						const chunkLength = parseInt(res.headers["content-length"] || "0", 10);
						let totalBytes = chunkLength;
						if (res.statusCode === 206) totalBytes += downloadedBytes;
						let currentProgress = downloadedBytes,
							lastTime = Date.now(),
							lastLoaded = downloadedBytes,
							progressTimer: NodeJS.Timeout | null = null,
							resTimeout: NodeJS.Timeout;
						const REPORT_INTERVAL = 250,
							fileStream = fsSync.createWriteStream(tmpFilePath, { flags: downloadedBytes > 0 ? "a" : "w" }),
							setResponseTimeout = () => {
								if (resTimeout) clearTimeout(resTimeout);
								resTimeout = setTimeout(() => {
									const err = new Error(`下载响应超时：超过 ${finalTimeout}ms 未接收到新数据`);
									req.destroy(err);
									fileStream.destroy(err);
								}, finalTimeout);
							},
							emitProgress = () => {
								if (!onProgress) return;
								const timeDiff = (Date.now() - lastTime) / 1000;
								if (timeDiff > 0 && currentProgress > lastLoaded) {
									const speed = (currentProgress - lastLoaded) / Math.max(timeDiff, 0.001);
									onProgress(currentProgress, totalBytes, speed);
									lastTime = Date.now();
									lastLoaded = currentProgress;
								}
							};
						progressTimer = setInterval(emitProgress, REPORT_INTERVAL);
						setResponseTimeout();
						res.on("data", chunk => {
							currentProgress += chunk.length;
							setResponseTimeout();
						});
						pipeline(res, fileStream)
							.then(async () => {
								if (progressTimer) clearInterval(progressTimer);
								if (resTimeout) clearTimeout(resTimeout);
								emitProgress();
								if (md5 && !tmpFilePath.includes(".manifest")) {
									const calculatedMd5 = await calculateFileMd5(tmpFilePath);
									if (calculatedMd5 && calculatedMd5.toLowerCase() !== md5.toLowerCase()) {
										return reject(new Error(`MD5 校验不匹配！预期: ${md5}, 计算出: ${calculatedMd5}`));
									}
								} else if (totalBytes && currentProgress !== totalBytes) {
									return reject(
										new Error(`文件完整性校验失败：预期大小 ${totalBytes}，实际下载 ${currentProgress}`),
									);
								}
								resolve();
							})
							.catch(err => {
								if (progressTimer) clearInterval(progressTimer);
								if (resTimeout) clearTimeout(resTimeout);
								reject(err);
							});
					});
					req.on("error", err => reject(err));
				});
			} catch (error: any) {
				if (error.message === "SERVER_NO_RANGE") {
					try {
						await fs.unlink(tmpFilePath);
					} catch {}
				}
				if (retryCount < finalMaxRetries) {
					const nextRetry = retryCount + 1;
					const delay = nextRetry * 500;
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
		},
		destDir = path.dirname(destFilePath),
		tmpFilePath = `${destFilePath}.tmp`;
	await fs.mkdir(destDir, { recursive: true });
	try {
		await fs.access(destFilePath);
		if (md5 && !url.includes(".manifest")) {
			const localMd5 = await calculateFileMd5(destFilePath);
			if (localMd5 && localMd5.toLowerCase() === md5.toLowerCase()) {
				onProgress?.(1, 1, 0);
				return destFilePath;
			}
		} else {
			const remoteSize = await getRemoteFileSize(url);
			const stats = await fs.stat(destFilePath);
			if (remoteSize > 0 && stats.size === remoteSize) {
				onProgress?.(1, 1, 0);
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
