const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

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
	const { md5 = null, onProgress = null, timeout = 15000, maxRetries = 5 } = options;
	options.timeout = Math.max(15000, timeout!);
	options.maxRetries = Math.max(5, maxRetries!);

	const calculateFileMd5 = (filePath: string): Promise<string | null> => {
		return new Promise((resolve, reject) => {
			if (!fs.existsSync(filePath)) return resolve(null);
			const hash = crypto.createHash("md5");
			const stream = fs.createReadStream(filePath);
			stream.on("data", data => hash.update(data));
			stream.on("end", () => resolve(hash.digest("hex")));
			stream.on("error", err => reject(err));
		});
	};

	const getRemoteFileSize = (url: string): Promise<number> => {
		return new Promise((resolve, reject) => {
			const client = url.startsWith("https") ? https : http;
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
	};

	const executeDownloadWithRetry = async (url: string, tmpFilePath: string, destFilePath: string, options: DownloadOptions, retryCount: number): Promise<string> => {
		const { md5 = null, onProgress = null } = options;
		try {
			let downloadedBytes = 0;
			if (fs.existsSync(tmpFilePath)) {
				downloadedBytes = fs.statSync(tmpFilePath).size;
			}
			const client = url.startsWith("https") ? https : http;
			const headers: http.OutgoingHttpHeaders = {};
			if (downloadedBytes > 0) {
				headers["Range"] = `bytes=${downloadedBytes}-`;
			}
			await new Promise((resolve, reject) => {
				const req = client.get(url, { headers }, res => {
					const statusCode = res.statusCode;
					if (statusCode === undefined || (statusCode !== 200 && statusCode !== 206)) {
						return reject(new Error(`服务器响应失败，状态码: ${statusCode}`));
					}
					const chunkLength = parseInt(res.headers["content-length"] || "0", 10);
					let totalBytes = chunkLength;
					if (statusCode === 206) {
						totalBytes = chunkLength + downloadedBytes;
					} else if (statusCode === 200 && downloadedBytes > 0) {
						downloadedBytes = 0;
						fs.writeFileSync(tmpFilePath, "");
					}
					const fileStream = fs.createWriteStream(tmpFilePath, { flags: "a" });
					let lastTime = Date.now();
					let lastLoaded = downloadedBytes;
					let currentProgress = downloadedBytes;
					let responseTimeoutId: NodeJS.Timeout;
					const setResponseTimeout = () => {
						if (responseTimeoutId) clearTimeout(responseTimeoutId);
						responseTimeoutId = setTimeout(() => {
							const err = new Error(`下载响应超时：超过 ${options.timeout}ms 未接收到新数据`);
							req && req.destroy(err);
							fileStream && fileStream.destroy(err);
						}, options.timeout);
					};
					res.on("data", chunk => {
						currentProgress += chunk.length;
						const nowTime = Date.now();
						const timeDiff = (nowTime - lastTime) / 1000;
						let currentSpeed = 0;
						if (timeDiff > 0) {
							currentSpeed = (currentProgress - lastLoaded) / timeDiff;
						}
						lastTime = nowTime;
						lastLoaded = currentProgress;
						setResponseTimeout();
						if (onProgress && typeof onProgress === "function") {
							onProgress(currentProgress, totalBytes, currentSpeed);
						}
					});
					setResponseTimeout();
					res.pipe(fileStream);
					fileStream.on("finish", async () => {
						clearTimeout(responseTimeoutId);
						if (md5 && !tmpFilePath.includes(".manifest")) {
							const calculatedMd5 = await calculateFileMd5(tmpFilePath);
							if (calculatedMd5 && calculatedMd5.toLowerCase() !== md5.toLowerCase()) {
								return reject(new Error(`MD5 校验不匹配！预期: ${md5}, 计算出: ${calculatedMd5}`));
							}
						} else {
							if (totalBytes && currentProgress !== totalBytes) {
								return reject(new Error(`文件完整性校验失败：预期大小 ${totalBytes}，实际下载 ${currentProgress}`));
							}
						}
						resolve(void 0);
					});
					res.on("error", err => {
						clearTimeout(responseTimeoutId);
						reject(err);
					});
					fileStream.on("error", err => {
						clearTimeout(responseTimeoutId);
						reject(err);
					});
				});
				req.on("error", err => reject(err));
			});
			if (fs.existsSync(destFilePath)) fs.unlinkSync(destFilePath);
			fs.renameSync(tmpFilePath, destFilePath);
			return destFilePath;
		} catch (error: any) {
			if (fs.existsSync(tmpFilePath)) {
				try {
					fs.unlinkSync(tmpFilePath);
				} catch (e) {}
			}
			if (retryCount < options.maxRetries!) {
				const nextRetry = retryCount + 1;
				const delay = nextRetry * 200;
				await new Promise(r => setTimeout(r, delay));
				return executeDownloadWithRetry(url, tmpFilePath, destFilePath, options, nextRetry);
			} else {
				let path = new URL(url).pathname;
				throw new Error(`${path}下载失败,下载已达到最大重试次数,相关原因：${error.message}`);
			}
		}
	};

	const destDir = path.dirname(destFilePath);
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}
	if (fs.existsSync(destFilePath) && !destFilePath.includes(".manifest")) {
		if (md5) {
			const localMd5 = await calculateFileMd5(destFilePath);
			if (localMd5 && localMd5.toLowerCase() === md5.toLowerCase()) {
				if (onProgress && typeof onProgress === "function") onProgress(1, 1, 0);
				return destFilePath;
			}
		} else {
			const remoteSize = await getRemoteFileSize(url);
			const localSize = fs.statSync(destFilePath).size;
			if (remoteSize > 0 && localSize === remoteSize) {
				if (onProgress && typeof onProgress === "function") onProgress(1, 1, 0);
				return destFilePath;
			}
		}
	}

	const tmpFilePath = `${destFilePath}.tmp`;
	return executeDownloadWithRetry(url, tmpFilePath, destFilePath, options, 0);
}
