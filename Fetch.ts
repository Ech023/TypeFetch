/**
 * HTTP 请求工具库 (基于 XMLHttpRequest)
 * 纯 TypeScript 实现，不依赖任何浏览器适配层
 *
 * @example
 * ```ts
 * import Fetch from "./fetch";
 *
 * // GET 请求
 * const data = await Fetch.Get<{ id: number }>("https://api.example.com/user", {
 *   params: { id: 1 },
 * });
 *
 * // POST 请求
 * const result = await Fetch.Post<{ success: boolean }>("https://api.example.com/login", {
 *   body: { username: "admin", password: "123456" },
 *   headers: { Authorization: "Bearer token" },
 * });
 * ```
 */

export namespace Fetch {
	/**
	 * URL 查询参数值的类型
	 * - 支持字符串、数字、布尔值、数组（会展开为多个同名字段）
	 * - `undefined` 和 `null` 会被跳过
	 */
	type ParamValue = string | number | boolean | undefined | null | (string | number | boolean)[];

	/** 请求配置 */
	export interface FetchOptions {
		/** HTTP 请求方法，默认 "GET" */
		method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

		/** 请求头，值为 `undefined` 的条目会被忽略 */
		headers?: Record<string, string | undefined>;

		/**
		 * 请求体
		 * - 普通对象自动按 JSON 序列化（若未指定 Content-Type 则自动设置为 application/json）
		 * - `FormData` / `Blob` 直接发送，不设置 Content-Type
		 * - `URLSearchParams` 直接发送，不做额外处理
		 * - GET/HEAD 请求忽略该字段
		 */
		body?: BodyInit | Record<string, unknown> | null;

		/** 超时时间（毫秒），默认 15000 */
		timeout?: number;

		/** 响应数据类型，默认自动推断 */
		responseType?: XMLHttpRequestResponseType;

		/**
		 * URL 查询参数
		 * 自动拼接到 URL 末尾，支持数组展开为多值
		 * @example { id: 1, tags: ["a", "b"] } => "?id=1&tags=a&tags=b"
		 */
		params?: Record<string, ParamValue>;

		/**
		 * 跨域凭证策略
		 * - `"include"`: 跨域请求携带凭证（设置 `withCredentials = true`）
		 * - `"omit"`: 不携带凭证
		 * - `"same-origin"`: 同域携带凭证（默认行为）
		 */
		credentials?: "include" | "omit" | "same-origin";

		/** 用于取消请求的 AbortSignal */
		signal?: AbortSignal;

		/** 下载进度回调 */
		onDownloadProgress?: (event: ProgressEvent) => void;

		/** 上传进度回调 */
		onUploadProgress?: (event: ProgressEvent) => void;
	}

	/** 响应头操作接口 */
	export interface ResFetchHeaders {
		/** 获取所有响应头名称 */
		keys: () => string[];

		/** 获取所有响应头键值对 */
		entries: () => [string, string][];

		/** 获取指定响应头的值，不存在返回 null */
		get: (name: string) => string | null;

		/** 判断指定响应头是否存在 */
		has: (name: string) => boolean;

		/** 遍历所有响应头 */
		forEach: (callback: (value: string, name: string) => void) => void;
	}

	/** 响应对象 */
	export interface FetchResponse<T = any> {
		/** 请求是否成功（状态码 200-299） */
		ok: boolean;

		/** HTTP 状态码 */
		status: number;

		/** HTTP 状态文本 */
		statusText: string;

		/** 请求最终 URL（可能经过重定向） */
		url: string;

		/** 是否发生过重定向（XHR 无法检测，始终为 false） */
		redirected: boolean;

		/** 响应头操作接口 */
		headers: ResFetchHeaders;

		/** 获取响应文本 */
		text: () => Promise<string>;

		/** 解析响应为 JSON（泛型参数可指定返回类型） */
		json: () => Promise<T>;

		/** 获取响应为 Blob */
		blob: () => Promise<Blob>;

		/** 获取响应为 ArrayBuffer */
		arrayBuffer: () => Promise<ArrayBuffer>;

		/** 克隆当前响应对象（用于多次读取 body） */
		clone: () => FetchResponse<T>;
	}

	/** 自定义 HTTP 请求错误 */
	export class FetchError extends Error {
		/** HTTP 状态码（网络错误为 0，超时为 408） */
		public status?: number;

		/** HTTP 状态文本 */
		public statusText?: string;

		/**
		 * @param message  错误描述
		 * @param status   HTTP 状态码
		 * @param statusText HTTP 状态文本
		 */
		constructor(message: string, status?: number, statusText?: string) {
			super(message);
			this.name = "FetchError";
			this.status = status;
			this.statusText = statusText;
		}
	}

	/**
	 * 解析 XMLHttpRequest 的原始响应头字符串
	 *
	 * @param rawHeaders - `getAllResponseHeaders()` 返回的原始字符串
	 * @returns 响应头操作接口
	 */
	function parseResponseHeaders(rawHeaders: string): ResFetchHeaders {
		const map: Record<string, string> = {};
		rawHeaders
			.trim()
			.split(/[\r\n]+/)
			.forEach(line => {
				const idx = line.indexOf(": ");
				if (idx !== -1) {
					const name = line.slice(0, idx).toLowerCase().trim();
					const value = line.slice(idx + 2).trim();
					map[name] = value;
				}
			});
		return {
			keys: () => Object.keys(map),
			entries: () => Object.entries(map),
			get: name => map[name.toLowerCase()] ?? null,
			has: name => name.toLowerCase() in map,
			forEach: callback => {
				for (const [k, v] of Object.entries(map)) callback(v, k);
			},
		};
	}

	/**
	 * 构建带查询参数的 URL
	 *
	 * @param baseUrl - 基础 URL
	 * @param params  - 查询参数（数组值会展开为多个同名参数）
	 * @returns 拼接后的完整 URL
	 */
	function buildUrl(baseUrl: string, params?: Record<string, unknown>): string {
		if (!params) return baseUrl;
		const parts: string[] = [];
		for (const [key, val] of Object.entries(params)) {
			if (val === undefined || val === null) continue;
			if (Array.isArray(val)) {
				for (const v of val) {
					parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
				}
			} else {
				parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
			}
		}
		if (parts.length === 0) return baseUrl;
		const separator = baseUrl.includes("?") ? "&" : "?";
		return baseUrl + separator + parts.join("&");
	}

	/**
	 * 序列化请求体，并根据 body 类型调整 Content-Type
	 *
	 * - 普通对象：按 JSON 或 x-www-form-urlencoded 序列化
	 * - FormData/Blob/URLSearchParams：直接透传
	 *
	 * @param body    - 原始请求体
	 * @param headers - 当前请求头（会被浅拷贝，不影响入参）
	 * @returns 序列化后的 body 和调整后的 headers
	 */
	function serializeBody(body: any, headers: Record<string, string>): { body: any; headers: Record<string, string> } {
		if (body === undefined || body === null) {
			return { body: null, headers };
		}
		// 浅拷贝避免修改入参
		let resultHeaders = { ...headers };
		// FormData 或 Blob 不设置 Content-Type（浏览器会自动处理）
		if (body instanceof FormData || body instanceof Blob) {
			delete resultHeaders["Content-Type"];
			return { body, headers: resultHeaders };
		}
		// 普通对象需要序列化
		if (typeof body === "object" && !(body instanceof URLSearchParams)) {
			let contentType = resultHeaders["Content-Type"];
			if (!contentType) {
				contentType = "application/json";
				resultHeaders["Content-Type"] = contentType;
			}
			if (contentType.includes("application/x-www-form-urlencoded")) {
				const encoded = Object.entries(body)
					.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
					.join("&");
				return { body: encoded, headers: resultHeaders };
			} else if (contentType.includes("application/json")) {
				return { body: JSON.stringify(body), headers: resultHeaders };
			}
		}
		return { body, headers: resultHeaders };
	}

	/**
	 * 核心请求方法
	 *
	 * @typeParam T - JSON 解析结果类型
	 * @param url     - 请求地址
	 * @param options - 请求配置
	 * @returns 响应对象
	 * @throws {FetchError} 网络错误 / HTTP 非 2xx / 超时 / 手动取消 / JSON 解析失败
	 */
	export async function request<T = any>(url: string, options: FetchOptions = {}): Promise<FetchResponse<T>> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			const method = options.method ?? "GET";
			const finalUrl = buildUrl(url, options.params);
			xhr.open(method, finalUrl, true);

			// 设置响应类型
			if (options.responseType) {
				xhr.responseType = options.responseType as XMLHttpRequestResponseType;
			}

			// 超时设置（默认 15s）
			xhr.timeout = options.timeout ?? 15000;

			// 准备请求头，过滤掉 undefined 值
			let finalHeaders: Record<string, string> = {};
			if (options.headers) {
				for (const [key, val] of Object.entries(options.headers)) {
					if (val !== undefined) finalHeaders[key] = String(val);
				}
			}

			// 处理请求体（GET/HEAD 不带 body）
			let requestBody: any = null;
			if (method !== "GET" && method !== "HEAD" && options.body !== undefined) {
				const { body: serialized, headers: updatedHeaders } = serializeBody(options.body, finalHeaders);
				requestBody = serialized;
				finalHeaders = updatedHeaders;
			}

			// 设置请求头（FormData 由浏览器自动设置 Content-Type，手动设置会干扰 boundary）
			if (!(requestBody instanceof FormData)) {
				for (const [key, val] of Object.entries(finalHeaders)) {
					if (val) xhr.setRequestHeader(key, val);
				}
			}

			// 跨域凭证
			if (options.credentials === "include") {
				xhr.withCredentials = true;
			}

			// 取消请求
			if (options.signal) {
				if (options.signal.aborted) {
					reject(new FetchError("Request aborted", 0));
					return;
				}
				options.signal.addEventListener("abort", () => {
					xhr.abort();
					reject(new FetchError("Request aborted", 0));
				});
			}

			// 进度回调
			if (options.onDownloadProgress) xhr.onprogress = options.onDownloadProgress;
			if (options.onUploadProgress) xhr.upload.onprogress = options.onUploadProgress;

			// 请求完成
			xhr.onload = () => {
				const responseHeaders = parseResponseHeaders(xhr.getAllResponseHeaders());
				const response: FetchResponse<T> = {
					ok: xhr.status >= 200 && xhr.status < 300,
					status: xhr.status,
					statusText: xhr.statusText,
					url: xhr.responseURL || finalUrl,
					redirected: false,
					headers: responseHeaders,
					text: async () => xhr.responseText ?? "",
					json: async () => {
						if (xhr.responseType === "json") return xhr.response;
						const text = xhr.responseText;
						if (!text) return null as T;
						try {
							return JSON.parse(text) as T;
						} catch {
							throw new FetchError("Failed to parse JSON", xhr.status, xhr.statusText);
						}
					},
					blob: async () => {
						if (xhr.response instanceof Blob) return xhr.response;
						return new Blob([xhr.response]);
					},
					arrayBuffer: async () => {
						if (xhr.responseType === "arraybuffer") return xhr.response;
						const blob = await response.blob();
						return blob.arrayBuffer();
					},
					clone: () => response,
				};

				if (response.ok) {
					resolve(response);
				} else {
					reject(new FetchError(`HTTP ${xhr.status}: ${xhr.statusText}`, xhr.status, xhr.statusText));
				}
			};

			// 错误处理
			xhr.onerror = () => reject(new FetchError("Network error", 0));
			xhr.ontimeout = () => reject(new FetchError("Request timeout", 408));

			// 发送请求
			if (method === "GET" || method === "HEAD") {
				xhr.send(null);
			} else {
				xhr.send(requestBody);
			}
		});
	}

	/** GET 请求（无请求体） */
	export const Get = <T = any>(url: string, options?: Omit<FetchOptions, "method" | "body">) => request<T>(url, { method: "GET", ...options });

	/** POST 请求 */
	export const Post = <T = any>(url: string, options?: Omit<FetchOptions, "method">) => request<T>(url, { method: "POST", ...options });

	/** PUT 请求 */
	export const Put = <T = any>(url: string, options?: Omit<FetchOptions, "method">) => request<T>(url, { method: "PUT", ...options });

	/** PATCH 请求 */
	export const Patch = <T = any>(url: string, options?: Omit<FetchOptions, "method">) => request<T>(url, { method: "PATCH", ...options });

	/** DELETE 请求 */
	export const Delete = <T = any>(url: string, options?: Omit<FetchOptions, "method">) => request<T>(url, { method: "DELETE", ...options });

	/** HEAD 请求（无请求体） */
	export const Head = <T = any>(url: string, options?: Omit<FetchOptions, "method" | "body">) => request<T>(url, { method: "HEAD", ...options });

	/** OPTIONS 请求 */
	export const Options = <T = any>(url: string, options?: Omit<FetchOptions, "method">) => request<T>(url, { method: "OPTIONS", ...options });
}

export default Fetch;
