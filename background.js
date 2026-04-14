//#region ../node_modules/.pnpm/zustand@5.0.8_@types+react@19.2.7_react@19.2.3/node_modules/zustand/esm/vanilla.mjs
var createStoreImpl = (createState) => {
	let state;
	const listeners = /* @__PURE__ */ new Set();
	const setState = (partial, replace) => {
		const nextState = typeof partial === "function" ? partial(state) : partial;
		if (!Object.is(nextState, state)) {
			const previousState = state;
			state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
			listeners.forEach((listener) => listener(state, previousState));
		}
	};
	const getState = () => state;
	const getInitialState = () => initialState;
	const subscribe = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const api = {
		setState,
		getState,
		getInitialState,
		subscribe
	};
	const initialState = state = createState(setState, getState, api);
	return api;
};
var createStore = ((createState) => createState ? createStoreImpl(createState) : createStoreImpl);
//#endregion
//#region ../playwriter/src/ghost-browser.ts
/**
* Handles ghost-browser commands in the extension.
* Calls the appropriate chrome.* API and returns the result.
*
* @param params - Command parameters (namespace, method, args)
* @param chromeApi - The chrome object (passed to avoid global dependency)
* @returns Result object with success/error status
*/
async function handleGhostBrowserCommand(params, chromeApi) {
	const { namespace, method, args } = params;
	try {
		const api = chromeApi[namespace];
		if (!api) return {
			success: false,
			error: `chrome.${namespace} not available (not running in Ghost Browser?)`
		};
		const fn = api[method];
		if (typeof fn !== "function") {
			if (method in api) return {
				success: true,
				result: api[method]
			};
			return {
				success: false,
				error: `chrome.${namespace}.${method} is not a function or property`
			};
		}
		return {
			success: true,
			result: await new Promise((resolve, reject) => {
				fn.call(api, ...args, (result) => {
					if (chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
					else resolve(result);
				});
			})
		};
	} catch (error) {
		return {
			success: false,
			error: error.message
		};
	}
}
//#endregion
//#region src/recording.ts
var activeRecordings = /* @__PURE__ */ new Map();
var offscreenDocumentCreating = null;
/**
* Get the active recordings map (for cleanup on tab disconnect).
*/
function getActiveRecordings() {
	return activeRecordings;
}
function isFirefox$1() {
	return navigator.userAgent.toLowerCase().includes("firefox");
}
function isRecordingSupported() {
	const c = chrome;
	return !isFirefox$1() && !!c["offscreen"] && !!c["tabCapture"];
}
async function ensureOffscreenDocument() {
	if ((await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		documentUrls: [chrome.runtime.getURL("src/offscreen.html")]
	})).length > 0) return;
	if (offscreenDocumentCreating) return offscreenDocumentCreating;
	offscreenDocumentCreating = chrome["offscreen"].createDocument({
		url: "src/offscreen.html",
		reasons: ["USER_MEDIA"],
		justification: "Screen recording via chrome.tabCapture"
	});
	try {
		await offscreenDocumentCreating;
	} finally {
		offscreenDocumentCreating = null;
	}
}
function resolveTabIdFromSessionId(sessionId) {
	if (!sessionId) {
		for (const [tabId, tab] of store.getState().tabs) if (tab.state === "connected") return tabId;
		return;
	}
	return getTabBySessionId(sessionId)?.tabId;
}
function updateTabRecordingState(tabId, isRecording) {
	store.setState((state) => {
		const newTabs = new Map(state.tabs);
		const existing = newTabs.get(tabId);
		if (existing) newTabs.set(tabId, {
			...existing,
			isRecording
		});
		return { tabs: newTabs };
	});
}
async function handleStartRecording(params) {
	if (!isRecordingSupported()) return {
		success: false,
		error: "Screen recording is not supported in this browser"
	};
	const tabId = resolveTabIdFromSessionId(params.sessionId);
	if (!tabId) return {
		success: false,
		error: "No connected tab found for recording. Click the Playwriter extension icon on the tab you want to record."
	};
	if (activeRecordings.has(tabId)) return {
		success: false,
		error: "Recording already in progress for this tab"
	};
	const tabInfo = store.getState().tabs.get(tabId);
	if (!tabInfo || tabInfo.state !== "connected") return {
		success: false,
		error: "Tab is not connected"
	};
	logger.debug("Starting recording for tab:", tabId, "params:", params);
	try {
		await ensureOffscreenDocument();
		const streamId = await new Promise((resolve, reject) => {
			chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
				if (chrome.runtime.lastError) {
					const errorMsg = chrome.runtime.lastError.message || "Unknown error";
					if (errorMsg.includes("Extension has not been invoked") || errorMsg.includes("activeTab")) reject(/* @__PURE__ */ new Error(`${errorMsg}. Click the Playwriter extension icon on this tab to enable recording.`));
					else reject(new Error(errorMsg));
				} else if (!id) reject(/* @__PURE__ */ new Error("Failed to get media stream ID"));
				else resolve(id);
			});
		});
		logger.debug("Got stream ID for tab:", tabId, "streamId:", streamId.substring(0, 20) + "...");
		const result = await chrome.runtime.sendMessage({
			action: "startRecording",
			tabId,
			streamId,
			frameRate: params.frameRate ?? 30,
			videoBitsPerSecond: params.videoBitsPerSecond ?? 25e5,
			audioBitsPerSecond: params.audioBitsPerSecond ?? 128e3,
			audio: params.audio ?? false
		});
		if (!result.success) return {
			success: false,
			error: result.error || "Failed to start recording in offscreen document"
		};
		const startedAt = result.startedAt || Date.now();
		activeRecordings.set(tabId, {
			tabId,
			startedAt
		});
		updateTabRecordingState(tabId, true);
		logger.debug("Recording started for tab:", tabId, "mimeType:", result.mimeType);
		return {
			success: true,
			tabId,
			startedAt
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("Failed to start recording:", error);
		return {
			success: false,
			error: errorMessage
		};
	}
}
async function handleStopRecording(params) {
	const tabId = resolveTabIdFromSessionId(params.sessionId);
	if (!tabId) return {
		success: false,
		error: "No connected tab found"
	};
	const recording = activeRecordings.get(tabId);
	if (!recording) return {
		success: false,
		error: "No active recording for this tab"
	};
	logger.debug("Stopping recording for tab:", tabId);
	try {
		const result = await chrome.runtime.sendMessage({
			action: "stopRecording",
			tabId
		});
		if (!result.success) return {
			success: false,
			error: result.error || "Failed to stop recording in offscreen document"
		};
		const duration = result.duration || Date.now() - recording.startedAt;
		activeRecordings.delete(tabId);
		updateTabRecordingState(tabId, false);
		logger.debug("Recording stopped for tab:", tabId, "duration:", duration);
		return {
			success: true,
			tabId,
			duration
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("Failed to stop recording:", error);
		return {
			success: false,
			error: errorMessage
		};
	}
}
async function handleIsRecording(params) {
	const tabId = resolveTabIdFromSessionId(params.sessionId);
	if (!tabId) return { isRecording: false };
	const recording = activeRecordings.get(tabId);
	if (!recording) return {
		isRecording: false,
		tabId
	};
	try {
		return {
			isRecording: (await chrome.runtime.sendMessage({
				action: "isRecording",
				tabId
			})).isRecording,
			tabId,
			startedAt: recording.startedAt
		};
	} catch {
		return {
			isRecording: false,
			tabId
		};
	}
}
async function handleCancelRecording(params) {
	const tabId = resolveTabIdFromSessionId(params.sessionId);
	if (!tabId) return {
		success: false,
		error: "No connected tab found"
	};
	if (!activeRecordings.get(tabId)) return { success: true };
	logger.debug("Cancelling recording for tab:", tabId);
	try {
		await chrome.runtime.sendMessage({
			action: "cancelRecording",
			tabId
		});
		activeRecordings.delete(tabId);
		updateTabRecordingState(tabId, false);
		if (connectionManager.ws?.readyState === WebSocket.OPEN) sendMessage({
			method: "recordingCancelled",
			params: { tabId }
		});
		return { success: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("Failed to cancel recording:", error);
		return {
			success: false,
			error: errorMessage
		};
	}
}
/**
* Clean up recordings when tab is disconnected.
*/
async function cleanupRecordingForTab(tabId) {
	if (activeRecordings.get(tabId)) {
		logger.debug("Cleaning up recording for disconnected tab:", tabId);
		try {
			await chrome.runtime.sendMessage({
				action: "cancelRecording",
				tabId
			});
		} catch (e) {
			logger.debug("Error cleaning up recording:", e);
		}
		activeRecordings.delete(tabId);
	}
}
//#endregion
//#region src/background.ts
var RELAY_HOST = "127.0.0.1";
var RELAY_PORT = 19988;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function createInstallId() {
	const values = new Uint32Array(2);
	crypto.getRandomValues(values);
	return Array.from(values).map((value) => {
		return value.toString(36);
	}).join("");
}
function isFirefox() {
	return navigator.userAgent.toLowerCase().includes("firefox");
}
var browserAction = (() => {
	const c = chrome;
	return c["action"] ?? c["browserAction"];
})();
async function detectBrowserName() {
	if (chrome.ghostPublicAPI) return "Ghost";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("firefox")) return "Firefox";
	const brands = navigator.userAgentData?.brands;
	if (brands && brands.length > 0) {
		const brandNames = brands.map((brand) => {
			return brand.brand.trim().toLowerCase();
		});
		if (brandNames.some((brand) => brand === "brave")) return "Brave";
		if (brandNames.some((brand) => brand === "microsoft edge")) return "Edge";
		if (brandNames.some((brand) => brand === "opera")) return "Opera";
		if (brandNames.some((brand) => brand === "vivaldi")) return "Vivaldi";
		if (brandNames.some((brand) => brand === "google chrome")) return "Chrome";
		if (brandNames.some((brand) => brand === "chromium")) return "Chromium";
	}
	if (ua.includes("edg/")) return "Edge";
	if (ua.includes("opr/")) return "Opera";
	if (ua.includes("vivaldi")) return "Vivaldi";
	if (ua.includes("brave")) return "Brave";
	if (ua.includes("chrome")) return "Chrome";
	return "Chromium";
}
var identityPromise = null;
var installIdPromise = null;
var tabSessionScope = (() => {
	const values = new Uint32Array(2);
	crypto.getRandomValues(values);
	return Array.from(values).map((value) => {
		return value.toString(36);
	}).join("");
})();
async function getInstallId() {
	if (installIdPromise) return installIdPromise;
	installIdPromise = (async () => {
		const existing = await chrome.storage.local.get("playwriterInstallId");
		const storedInstallId = typeof existing.playwriterInstallId === "string" ? existing.playwriterInstallId : "";
		if (storedInstallId) return storedInstallId;
		const installId = createInstallId();
		await chrome.storage.local.set({ playwriterInstallId: installId });
		return installId;
	})().catch((error) => {
		installIdPromise = null;
		throw error;
	});
	return installIdPromise;
}
async function getExtensionIdentity() {
	if (identityPromise) return identityPromise;
	identityPromise = (async () => {
		const browser = await detectBrowserName();
		const installId = await getInstallId().catch(() => {
			return tabSessionScope;
		});
		try {
			if (!isFirefox() && chrome.identity?.getProfileUserInfo) {
				const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
				return {
					browser,
					email: info.email || "",
					id: info.id || "",
					installId
				};
			}
		} catch {}
		return {
			browser,
			email: "",
			id: "",
			installId
		};
	})();
	return identityPromise;
}
var TAB_GROUP_COLOR = "green";
var TAB_GROUP_TITLE = "playwriter";
var childSessions = /* @__PURE__ */ new Map();
var nextSessionId = 1;
var tabGroupQueue = Promise.resolve();
var autoAttachParams = null;
var recordingChunkBuffer = [];
/**
* Flush buffered recording chunks to the WebSocket.
* Called when WebSocket becomes ready.
*/
function flushRecordingChunkBuffer(ws) {
	if (recordingChunkBuffer.length === 0) return;
	logger.debug(`Flushing ${recordingChunkBuffer.length} buffered recording chunks`);
	while (recordingChunkBuffer.length > 0) {
		const { tabId, data, final } = recordingChunkBuffer.shift();
		ws.send(JSON.stringify({
			method: "recordingData",
			params: {
				tabId,
				final
			}
		}));
		if (data && !final) {
			const buffer = new Uint8Array(data);
			ws.send(buffer);
		}
	}
}
var ConnectionManager = class {
	ws = null;
	connectionPromise = null;
	preserveTabsOnDetach = false;
	async ensureConnection() {
		if (this.ws?.readyState === WebSocket.OPEN) return;
		if (store.getState().connectionState === "extension-replaced") throw new Error("Another Playwriter extension is already connected");
		if (this.connectionPromise) return this.connectionPromise;
		const GLOBAL_TIMEOUT_MS = 15e3;
		this.connectionPromise = Promise.race([this.connect(), new Promise((_, reject) => {
			setTimeout(() => {
				reject(/* @__PURE__ */ new Error("Connection timeout (global)"));
			}, GLOBAL_TIMEOUT_MS);
		})]);
		try {
			await this.connectionPromise;
		} finally {
			this.connectionPromise = null;
		}
	}
	async connect() {
		logger.debug(`Waiting for server at http://${RELAY_HOST}:${RELAY_PORT}...`);
		const maxAttempts = 5;
		for (let attempt = 0; attempt < maxAttempts; attempt++) try {
			await fetch(`http://${RELAY_HOST}:${RELAY_PORT}`, {
				method: "HEAD",
				signal: AbortSignal.timeout(2e3)
			});
			logger.debug("Server is available");
			break;
		} catch {
			if (attempt === maxAttempts - 1) throw new Error("Server not available");
			logger.debug(`Server not available, retrying... (attempt ${attempt + 1}/${maxAttempts})`);
			await sleep(1e3);
		}
		const identity = await getExtensionIdentity();
		const relayUrl = new URL(`ws://${RELAY_HOST}:${RELAY_PORT}/extension`);
		if (identity.browser) relayUrl.searchParams.set("browser", identity.browser);
		if (identity.email) relayUrl.searchParams.set("email", identity.email);
		if (identity.id) relayUrl.searchParams.set("id", identity.id);
		if (identity.installId) relayUrl.searchParams.set("installId", identity.installId);
		relayUrl.searchParams.set("v", "0.0.105");
		logger.debug("Creating WebSocket connection to:", relayUrl);
		const socket = new WebSocket(relayUrl.toString());
		await new Promise((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				logger.debug("WebSocket connection TIMEOUT after 5 seconds");
				try {
					socket.close();
				} catch {}
				reject(/* @__PURE__ */ new Error("Connection timeout"));
			}, 5e3);
			socket.onopen = () => {
				if (settled) return;
				settled = true;
				logger.debug("WebSocket connected");
				clearTimeout(timeout);
				flushRecordingChunkBuffer(socket);
				resolve();
			};
			socket.onerror = (error) => {
				logger.debug("WebSocket error during connection:", error);
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(/* @__PURE__ */ new Error("WebSocket connection failed"));
			};
			socket.onclose = (event) => {
				logger.debug("WebSocket closed during connection:", {
					code: event.code,
					reason: event.reason
				});
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (event.code === 4002 || event.reason === "Extension Already In Use") reject(/* @__PURE__ */ new Error("Extension Already In Use"));
				else reject(/* @__PURE__ */ new Error(`WebSocket closed: ${event.reason || event.code}`));
			};
		});
		this.ws = socket;
		this.ws.onmessage = async (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch (error) {
				logger.debug("Error parsing message:", error);
				sendMessage({ error: {
					code: -32700,
					message: `Error parsing message: ${error.message}`
				} });
				return;
			}
			if (message.method === "ping") {
				sendMessage({ method: "pong" });
				return;
			}
			if (message.method === "createInitialTab") {
				try {
					logger.debug("Creating initial tab for Playwright client");
					const tab = await chrome.tabs.create({
						url: "about:blank",
						active: false
					});
					if (tab.id) {
						setTabConnecting(tab.id);
						const { targetInfo, sessionId } = await attachTab(tab.id, { skipAttachedEvent: true });
						logger.debug("Initial tab created and connected:", tab.id, "sessionId:", sessionId);
						sendMessage({
							id: message.id,
							result: {
								success: true,
								tabId: tab.id,
								sessionId,
								targetInfo
							}
						});
					} else throw new Error("Failed to create tab - no tab ID returned");
				} catch (error) {
					logger.debug("Failed to create initial tab:", error);
					sendMessage({
						id: message.id,
						error: error.message
					});
				}
				return;
			}
			if (message.method === "startRecording") {
				try {
					const result = await handleStartRecording(message.params);
					sendMessage({
						id: message.id,
						result
					});
				} catch (error) {
					logger.error("Failed to start recording:", error);
					sendMessage({
						id: message.id,
						result: {
							success: false,
							error: error.message
						}
					});
				}
				return;
			}
			if (message.method === "stopRecording") {
				try {
					const result = await handleStopRecording(message.params);
					sendMessage({
						id: message.id,
						result
					});
				} catch (error) {
					logger.error("Failed to stop recording:", error);
					sendMessage({
						id: message.id,
						result: {
							success: false,
							error: error.message
						}
					});
				}
				return;
			}
			if (message.method === "isRecording") {
				try {
					const result = await handleIsRecording(message.params);
					sendMessage({
						id: message.id,
						result
					});
				} catch (error) {
					logger.error("Failed to check recording status:", error);
					sendMessage({
						id: message.id,
						result: { isRecording: false }
					});
				}
				return;
			}
			if (message.method === "cancelRecording") {
				try {
					const result = await handleCancelRecording(message.params);
					sendMessage({
						id: message.id,
						result
					});
				} catch (error) {
					logger.error("Failed to cancel recording:", error);
					sendMessage({
						id: message.id,
						result: {
							success: false,
							error: error.message
						}
					});
				}
				return;
			}
			if (message.method === "ghost-browser") {
				const params = message.params;
				const result = await handleGhostBrowserCommand(params, chrome);
				if (!result.success) logger.error("Ghost Browser API error:", result.error);
				if (result.success && params.namespace === "ghostPublicAPI" && params.method === "openTab") {
					const tabId = result.result;
					if (tabId) {
						logger.debug("Auto-connecting Ghost Browser tab:", tabId);
						setTabConnecting(tabId);
						await sleep(100);
						await attachTab(tabId);
					}
				}
				sendMessage({
					id: message.id,
					result
				});
				return;
			}
			const response = { id: message.id };
			try {
				response.result = await handleCommand(message);
			} catch (error) {
				logger.debug("Error handling command:", error);
				response.error = error.message;
			}
			sendMessage(response);
		};
		this.ws.onclose = (event) => {
			this.handleClose(event.reason, event.code);
		};
		this.ws.onerror = (event) => {
			logger.debug("WebSocket error:", event);
		};
		chrome.debugger.onEvent.addListener(onDebuggerEvent);
		chrome.debugger.onDetach.addListener(onDebuggerDetach);
		logger.debug("Connection established");
	}
	handleClose(reason, code) {
		try {
			const mem = performance.memory;
			if (mem) {
				const formatMB = (b) => (b / 1024 / 1024).toFixed(2) + "MB";
				logger.warn(`DISCONNECT MEMORY: used=${formatMB(mem.usedJSHeapSize)} total=${formatMB(mem.totalJSHeapSize)} limit=${formatMB(mem.jsHeapSizeLimit)}`);
			}
		} catch {}
		logger.warn(`DISCONNECT: WS closed code=${code} reason=${reason || "none"} stack=${getCallStack()}`);
		chrome.debugger.onEvent.removeListener(onDebuggerEvent);
		chrome.debugger.onDetach.removeListener(onDebuggerDetach);
		const isExtensionReplaced = reason === "Extension Replaced" || code === 4001;
		const isExtensionInUse = reason === "Extension Already In Use" || code === 4002;
		this.preserveTabsOnDetach = !(isExtensionReplaced || isExtensionInUse);
		const { tabs } = store.getState();
		for (const [tabId] of tabs) chrome.debugger.detach({ tabId }).catch((err) => {
			logger.debug("Error detaching from tab:", tabId, err.message);
		});
		childSessions.clear();
		this.ws = null;
		if (isExtensionReplaced) {
			logger.debug("Disconnected: another Playwriter extension connected (this one was idle)");
			store.setState({
				tabs: /* @__PURE__ */ new Map(),
				connectionState: "extension-replaced",
				errorText: "Another Playwriter extension took over the connection"
			});
			return;
		}
		if (isExtensionInUse) {
			logger.debug("Rejected: another Playwriter extension is actively in use");
			store.setState({
				tabs: /* @__PURE__ */ new Map(),
				connectionState: "extension-replaced",
				errorText: "Another Playwriter extension is actively in use"
			});
			return;
		}
		store.setState((state) => {
			const newTabs = new Map(state.tabs);
			for (const [tabId, tab] of newTabs) newTabs.set(tabId, {
				...tab,
				state: "connecting"
			});
			return {
				tabs: newTabs,
				connectionState: "idle",
				errorText: void 0
			};
		});
	}
	async maintainLoop() {
		while (true) {
			if (this.ws?.readyState === WebSocket.OPEN) {
				await sleep(1e3);
				continue;
			}
			if (store.getState().connectionState === "extension-replaced") {
				try {
					const data = await (await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/extension/status`, {
						method: "GET",
						signal: AbortSignal.timeout(2e3)
					})).json();
					if (!data.connected) {
						store.setState({
							connectionState: "idle",
							errorText: void 0
						});
						logger.debug("Extension slot is free (connected:", data.connected, "activeTargets:", data.activeTargets, "), cleared error state");
					} else logger.debug("Extension slot still taken (activeTargets:", data.activeTargets, "), will retry...");
				} catch {
					logger.debug("Server not available, will retry...");
				}
				await sleep(3e3);
				continue;
			}
			const currentTabs = store.getState().tabs;
			if (Array.from(currentTabs.values()).some((t) => t.state === "connected")) store.setState((state) => {
				const newTabs = new Map(state.tabs);
				for (const [tabId, tab] of newTabs) if (tab.state === "connected") newTabs.set(tabId, {
					...tab,
					state: "connecting"
				});
				return { tabs: newTabs };
			});
			try {
				await this.ensureConnection();
				store.setState({ connectionState: "connected" });
				const tabsToReattach = Array.from(store.getState().tabs.entries()).filter(([_, tab]) => tab.state === "connecting").map(([tabId]) => tabId);
				for (const tabId of tabsToReattach) {
					const currentTab = store.getState().tabs.get(tabId);
					if (!currentTab || currentTab.state !== "connecting") {
						logger.debug("Skipping reattach, tab state changed:", tabId, currentTab?.state);
						continue;
					}
					try {
						await chrome.tabs.get(tabId);
						await attachTab(tabId);
						logger.debug("Successfully re-attached tab:", tabId);
					} catch (error) {
						logger.debug("Failed to re-attach tab:", tabId, error.message);
						store.setState((state) => {
							const newTabs = new Map(state.tabs);
							newTabs.delete(tabId);
							return { tabs: newTabs };
						});
					}
				}
				this.preserveTabsOnDetach = false;
			} catch (error) {
				logger.debug("Connection attempt failed:", error.message);
				if (error.message === "Extension Already In Use") store.setState({
					connectionState: "extension-replaced",
					errorText: "Another Playwriter extension is actively in use"
				});
				else store.setState({ connectionState: "idle" });
			}
			await sleep(3e3);
		}
	}
};
var connectionManager = new ConnectionManager();
var store = createStore(() => ({
	tabs: /* @__PURE__ */ new Map(),
	connectionState: "idle",
	currentTabId: void 0,
	errorText: void 0
}));
globalThis.toggleExtensionForActiveTab = toggleExtensionForActiveTab;
globalThis.disconnectEverything = disconnectEverything;
globalThis.getExtensionState = () => store.getState();
var MAX_LOG_STRING_LENGTH = 2e3;
function truncateLogString(value) {
	if (value.length <= MAX_LOG_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_LOG_STRING_LENGTH)}…[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
}
function safeSerialize(arg) {
	if (arg === void 0) return "undefined";
	if (arg === null) return "null";
	if (typeof arg === "function") return `[Function: ${arg.name || "anonymous"}]`;
	if (typeof arg === "symbol") return String(arg);
	if (typeof arg === "string") return truncateLogString(arg);
	if (arg instanceof Error) return truncateLogString(arg.stack || arg.message || String(arg));
	if (typeof arg === "object") try {
		const seen = /* @__PURE__ */ new WeakSet();
		return truncateLogString(JSON.stringify(arg, (key, value) => {
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
				if (value instanceof Map) return {
					dataType: "Map",
					value: Array.from(value.entries())
				};
				if (value instanceof Set) return {
					dataType: "Set",
					value: Array.from(value.values())
				};
			}
			return value;
		}));
	} catch {
		return truncateLogString(String(arg));
	}
	return truncateLogString(String(arg));
}
function sendLog(level, args) {
	sendMessage({
		method: "log",
		params: {
			level,
			args: args.map(safeSerialize)
		}
	});
}
var logger = {
	log: (...args) => {
		console.log(...args);
		sendLog("log", args);
	},
	debug: (...args) => {
		console.debug(...args);
		sendLog("debug", args);
	},
	info: (...args) => {
		console.info(...args);
		sendLog("info", args);
	},
	warn: (...args) => {
		console.warn(...args);
		sendLog("warn", args);
	},
	error: (...args) => {
		console.error(...args);
		sendLog("error", args);
	}
};
function getCallStack() {
	return ((/* @__PURE__ */ new Error()).stack || "").split("\n").slice(2, 6).join(" <- ").replace(/\s+/g, " ");
}
self.addEventListener("error", (event) => {
	const stack = event.error?.stack || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
	logger.error("Uncaught error:", stack);
});
self.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const stack = reason?.stack || String(reason);
	logger.error("Unhandled promise rejection:", stack);
});
var messageCount = 0;
function sendMessage(message) {
	if (connectionManager.ws?.readyState === WebSocket.OPEN) try {
		connectionManager.ws.send(JSON.stringify(message));
		if (++messageCount % 100 === 0) checkMemory();
	} catch (error) {
		console.debug("ERROR sending message:", error, "message type:", message.method || "response");
	}
}
async function syncTabGroup() {
	if (isFirefox() || !chrome.tabGroups) return;
	try {
		const { connectionState } = store.getState();
		const isRelayConnected = connectionState === "connected";
		const connectedTabIds = Array.from(store.getState().tabs.entries()).filter(([_, info]) => info.state === "connected" || info.state === "connecting" && isRelayConnected).map(([tabId]) => tabId);
		const existingGroups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE });
		if (connectedTabIds.length === 0) {
			for (const group of existingGroups) {
				const tabIdsToUngroup = (await chrome.tabs.query({ groupId: group.id })).map((t) => t.id).filter((id) => id !== void 0);
				if (tabIdsToUngroup.length > 0) await chrome.tabs.ungroup(tabIdsToUngroup);
				logger.debug("Cleared playwriter group:", group.id);
			}
			return;
		}
		let groupId = existingGroups[0]?.id;
		if (existingGroups.length > 1) {
			const [keep, ...duplicates] = existingGroups;
			groupId = keep.id;
			for (const group of duplicates) {
				const tabIdsToUngroup = (await chrome.tabs.query({ groupId: group.id })).map((t) => t.id).filter((id) => id !== void 0);
				if (tabIdsToUngroup.length > 0) await chrome.tabs.ungroup(tabIdsToUngroup);
				logger.debug("Removed duplicate playwriter group:", group.id);
			}
		}
		const tabsInGroup = (await chrome.tabs.query({})).filter((t) => t.groupId === groupId && t.id !== void 0);
		const tabIdsInGroup = new Set(tabsInGroup.map((t) => t.id));
		const tabsToAdd = connectedTabIds.filter((id) => !tabIdsInGroup.has(id));
		const tabsToRemove = Array.from(tabIdsInGroup).filter((id) => !connectedTabIds.includes(id));
		if (tabsToRemove.length > 0) try {
			await chrome.tabs.ungroup(tabsToRemove);
			logger.debug("Removed tabs from group:", tabsToRemove);
		} catch (e) {
			logger.debug("Failed to ungroup tabs:", tabsToRemove, e.message);
		}
		if (tabsToAdd.length > 0) if (groupId === void 0) {
			const newGroupId = await chrome.tabs.group({ tabIds: tabsToAdd });
			await chrome.tabGroups.update(newGroupId, {
				title: TAB_GROUP_TITLE,
				color: TAB_GROUP_COLOR
			});
			logger.debug("Created tab group:", newGroupId, "with tabs:", tabsToAdd);
		} else {
			await chrome.tabs.group({
				tabIds: tabsToAdd,
				groupId
			});
			await chrome.tabGroups.update(groupId, {
				title: TAB_GROUP_TITLE,
				color: TAB_GROUP_COLOR
			});
			logger.debug("Added tabs to existing group:", tabsToAdd);
		}
		else if (groupId !== void 0) await chrome.tabGroups.update(groupId, {
			title: TAB_GROUP_TITLE,
			color: TAB_GROUP_COLOR
		});
	} catch (error) {
		logger.debug("Failed to sync tab group:", error.message);
	}
}
function getTabBySessionId(sessionId) {
	for (const [tabId, tab] of store.getState().tabs) if (tab.sessionId === sessionId) return {
		tabId,
		tab
	};
}
function getTabByTargetId(targetId) {
	for (const [tabId, tab] of store.getState().tabs) if (tab.targetId === targetId) return {
		tabId,
		tab
	};
}
function emitChildDetachesForTab(tabId) {
	Array.from(childSessions.entries()).filter(([_, parentTab]) => parentTab.tabId === tabId).forEach(([childSessionId, parentTab]) => {
		sendMessage({
			method: "forwardCDPEvent",
			params: {
				method: "Target.detachedFromTarget",
				params: parentTab.targetId ? {
					sessionId: childSessionId,
					targetId: parentTab.targetId
				} : { sessionId: childSessionId }
			}
		});
		logger.debug("Cleaning up child session:", childSessionId, "for tab:", tabId);
		childSessions.delete(childSessionId);
	});
}
function getTabForCommand(msg) {
	const sessionId = msg.params.sessionId;
	if (sessionId) {
		const found = getTabBySessionId(sessionId);
		if (found) return found;
		const child = childSessions.get(sessionId);
		if (child) {
			const tab = store.getState().tabs.get(child.tabId);
			if (tab) return {
				tabId: child.tabId,
				tab
			};
		}
	}
	const paramsSessionId = msg.params.params && "sessionId" in msg.params.params && typeof msg.params.params.sessionId === "string" ? msg.params.params.sessionId : void 0;
	if (paramsSessionId) {
		const found = getTabBySessionId(paramsSessionId);
		if (found) return found;
		const child = childSessions.get(paramsSessionId);
		if (child) {
			const tab = store.getState().tabs.get(child.tabId);
			if (tab) return {
				tabId: child.tabId,
				tab
			};
		}
	}
	const targetId = msg.params.params && "targetId" in msg.params.params && typeof msg.params.params.targetId === "string" ? msg.params.params.targetId : void 0;
	if (targetId) return getTabByTargetId(targetId);
}
async function handleCommand(msg) {
	if (msg.method !== "forwardCDPCommand") return;
	const resolved = getTabForCommand(msg);
	let targetTabId = resolved?.tabId;
	let targetTab = resolved?.tab;
	const debuggee = targetTabId ? { tabId: targetTabId } : void 0;
	if (msg.params.method === "Target.setAutoAttach" && !msg.params.sessionId) {
		const params = msg.params.params;
		if (!params) return {};
		autoAttachParams = params;
		const connectedTabIds = Array.from(store.getState().tabs.entries()).filter(([_, info]) => info.state === "connected").map(([tabId]) => tabId);
		await Promise.all(connectedTabIds.map(async (tabId) => {
			try {
				await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", params);
			} catch (error) {
				logger.debug("Failed to set auto-attach for tab:", tabId, error);
			}
		}));
		return {};
	}
	switch (msg.params.method) {
		case "Runtime.enable": {
			if (!debuggee) throw new Error(`No debuggee found for Runtime.enable (sessionId: ${msg.params.sessionId})`);
			const runtimeSession = {
				...debuggee,
				sessionId: msg.params.sessionId !== targetTab?.sessionId ? msg.params.sessionId : void 0
			};
			try {
				await chrome.debugger.sendCommand(runtimeSession, "Runtime.disable");
				await sleep(50);
			} catch (e) {
				logger.debug("Error disabling Runtime (ignoring):", e);
			}
			return await chrome.debugger.sendCommand(runtimeSession, "Runtime.enable", msg.params.params);
		}
		case "Target.createTarget": {
			const url = msg.params.params?.url || "about:blank";
			logger.debug("Creating new tab with URL:", url);
			const tab = await chrome.tabs.create({
				url,
				active: false
			});
			if (!tab.id) throw new Error("Failed to create tab");
			setTabConnecting(tab.id);
			logger.debug("Created tab:", tab.id, "waiting for it to load...");
			await sleep(100);
			const { targetInfo } = await attachTab(tab.id);
			return { targetId: targetInfo.targetId };
		}
		case "Target.closeTarget":
			if (!targetTabId) {
				logger.log(`Target not found: ${msg.params.params?.targetId}`);
				return { success: false };
			}
			await chrome.tabs.remove(targetTabId);
			return { success: true };
	}
	if (!debuggee || !targetTab) {
		if (msg.params.method === "Target.detachFromTarget") return {};
		throw new Error(`No tab found for method ${msg.params.method} sessionId: ${msg.params.sessionId} params: ${JSON.stringify(msg.params.params || null)}`);
	}
	logger.debug("CDP command:", msg.params.method, "for tab:", targetTabId);
	const debuggerSession = {
		...debuggee,
		sessionId: msg.params.sessionId !== targetTab.sessionId ? msg.params.sessionId : void 0
	};
	return await chrome.debugger.sendCommand(debuggerSession, msg.params.method, msg.params.params);
}
function onDebuggerEvent(source, method, params) {
	const tab = source.tabId ? store.getState().tabs.get(source.tabId) : void 0;
	if (!tab) return;
	logger.debug("Forwarding CDP event:", method, "from tab:", source.tabId);
	if (method === "Target.attachedToTarget" && params?.sessionId) {
		const targetUrl = params.targetInfo?.url;
		if (isRestrictedUrl(targetUrl)) {
			logger.debug("Ignoring restricted child target:", targetUrl, "sessionId:", params.sessionId, "for tab:", source.tabId);
			if (source.tabId) chrome.debugger.sendCommand({ tabId: source.tabId }, "Target.detachFromTarget", { sessionId: params.sessionId }).catch((e) => {
				logger.debug("Failed to detach restricted child target (expected):", e);
			});
			return;
		}
		logger.debug("Child target attached:", params.sessionId, "for tab:", source.tabId);
		const targetId = params.targetInfo?.targetId;
		childSessions.set(params.sessionId, {
			tabId: source.tabId,
			targetId
		});
	}
	if (method === "Target.detachedFromTarget" && params?.sessionId) {
		const mainTab = getTabBySessionId(params.sessionId);
		if (mainTab) {
			logger.debug("Main tab detached via CDP event:", mainTab.tabId, "sessionId:", params.sessionId);
			store.setState((state) => {
				const newTabs = new Map(state.tabs);
				newTabs.delete(mainTab.tabId);
				return { tabs: newTabs };
			});
			emitChildDetachesForTab(mainTab.tabId);
		} else {
			logger.debug("Child target detached:", params.sessionId);
			childSessions.delete(params.sessionId);
		}
	}
	sendMessage({
		method: "forwardCDPEvent",
		params: {
			sessionId: source.sessionId || tab.sessionId,
			method,
			params
		}
	});
}
function onDebuggerDetach(source, reason) {
	const tabId = source.tabId;
	if (!tabId || !store.getState().tabs.has(tabId)) {
		logger.debug("Ignoring debugger detach event for untracked tab:", tabId);
		return;
	}
	if (connectionManager.preserveTabsOnDetach) {
		logger.debug("Ignoring debugger detach during relay reconnect:", tabId, reason);
		return;
	}
	logger.warn(`DISCONNECT: onDebuggerDetach tabId=${tabId} reason=${reason}`);
	const tab = store.getState().tabs.get(tabId);
	if (tab) sendMessage({
		method: "forwardCDPEvent",
		params: {
			method: "Target.detachedFromTarget",
			params: {
				sessionId: tab.sessionId,
				targetId: tab.targetId
			}
		}
	});
	emitChildDetachesForTab(tabId);
	store.setState((state) => {
		const newTabs = new Map(state.tabs);
		newTabs.delete(tabId);
		return { tabs: newTabs };
	});
	if (reason === "canceled_by_user" || reason === "user_canceled") store.setState({
		connectionState: "idle",
		errorText: void 0
	});
}
async function removeRestrictedIframes(tabId) {
	try {
		const totalRemoved = (await chrome.scripting.executeScript({
			target: {
				tabId,
				allFrames: true
			},
			func: (ownExtIds) => {
				const roots = [document];
				document.querySelectorAll("*").forEach((el) => {
					const shadow = el.shadowRoot;
					if (shadow) roots.push(shadow);
				});
				const EXT_SCHEMES = ["chrome-extension://", "moz-extension://"];
				let removed = 0;
				for (const root of roots) root.querySelectorAll("iframe").forEach((iframe) => {
					const src = iframe.src || iframe.getAttribute("src") || "";
					const scheme = EXT_SCHEMES.find((s) => src.startsWith(s));
					if (!scheme) return;
					const extId = src.slice(scheme.length).split("/")[0];
					if (ownExtIds.includes(extId)) return;
					iframe.remove();
					removed++;
				});
				return removed;
			},
			args: [[OUR_OWN_EXTENSION_ID, ...OUR_EXTENSION_IDS]]
		})).reduce((sum, r) => sum + (r.result ?? 0), 0);
		if (totalRemoved > 0) logger.debug(`Removed ${totalRemoved} restricted chrome-extension:// iframe(s) from tab:`, tabId);
		return totalRemoved;
	} catch (e) {
		logger.debug("Could not remove restricted iframes (expected on some pages):", e.message);
		return 0;
	}
}
async function attachTab(tabId, { skipAttachedEvent = false } = {}) {
	const debuggee = { tabId };
	let debuggerAttached = false;
	try {
		logger.debug("Attaching debugger to tab:", tabId);
		const maxAttachAttempts = 3;
		for (let attempt = 1; attempt <= maxAttachAttempts; attempt++) try {
			await chrome.debugger.attach(debuggee, "1.3");
			break;
		} catch (attachError) {
			const msg = attachError.message ?? "";
			if (!(msg.includes("chrome-extension://") || msg.includes("different extension")) || attempt === maxAttachAttempts) throw attachError;
			logger.debug(`Debugger attach blocked by chrome-extension:// iframe (attempt ${attempt}/${maxAttachAttempts}), removing and retrying:`, tabId);
			await removeRestrictedIframes(tabId);
			await sleep(50);
		}
		debuggerAttached = true;
		logger.debug("Debugger attached successfully to tab:", tabId);
		await chrome.debugger.sendCommand(debuggee, "Page.enable");
		if (autoAttachParams) try {
			await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", autoAttachParams);
		} catch (error) {
			logger.debug("Failed to apply auto-attach for tab:", tabId, error);
		}
		const contextMenuScript = `
      document.addEventListener('contextmenu', (e) => {
        window.__playwriter_lastRightClicked = e.target;
      }, true);
    `;
		await chrome.debugger.sendCommand(debuggee, "Page.addScriptToEvaluateOnNewDocument", { source: contextMenuScript });
		await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: contextMenuScript });
		const targetInfo = (await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo")).targetInfo;
		if (!targetInfo.url || targetInfo.url === "" || targetInfo.url === ":") logger.error("WARNING: Target.attachedToTarget will be sent with empty URL! tabId:", tabId, "targetInfo:", JSON.stringify(targetInfo));
		const attachOrder = nextSessionId;
		const sessionId = `pw-tab-${tabSessionScope}-${nextSessionId++}`;
		store.setState((state) => {
			const newTabs = new Map(state.tabs);
			newTabs.set(tabId, {
				sessionId,
				targetId: targetInfo.targetId,
				state: "connected",
				attachOrder
			});
			return {
				tabs: newTabs,
				connectionState: "connected",
				errorText: void 0
			};
		});
		if (!skipAttachedEvent) sendMessage({
			method: "forwardCDPEvent",
			params: {
				method: "Target.attachedToTarget",
				params: {
					sessionId,
					targetInfo: {
						...targetInfo,
						attached: true
					},
					waitingForDebugger: false
				}
			}
		});
		logger.debug("Tab attached successfully:", tabId, "sessionId:", sessionId, "targetId:", targetInfo.targetId, "url:", targetInfo.url, "skipAttachedEvent:", skipAttachedEvent);
		return {
			targetInfo,
			sessionId
		};
	} catch (error) {
		if (debuggerAttached) {
			logger.debug("Cleaning up debugger after partial attach failure:", tabId);
			chrome.debugger.detach(debuggee).catch(() => {});
		}
		throw error;
	}
}
function detachTab(tabId, shouldDetachDebugger) {
	const tab = store.getState().tabs.get(tabId);
	if (!tab) {
		logger.debug("detachTab: tab not found in map:", tabId);
		return;
	}
	cleanupRecordingForTab(tabId);
	logger.warn(`DISCONNECT: detachTab tabId=${tabId} shouldDetach=${shouldDetachDebugger} stack=${getCallStack()}`);
	if (tab.sessionId && tab.targetId) sendMessage({
		method: "forwardCDPEvent",
		params: {
			method: "Target.detachedFromTarget",
			params: {
				sessionId: tab.sessionId,
				targetId: tab.targetId
			}
		}
	});
	store.setState((state) => {
		const newTabs = new Map(state.tabs);
		newTabs.delete(tabId);
		return { tabs: newTabs };
	});
	emitChildDetachesForTab(tabId);
	if (shouldDetachDebugger) chrome.debugger.detach({ tabId }).catch((err) => {
		logger.debug("Error detaching debugger from tab:", tabId, err.message);
	});
}
async function connectTab(tabId) {
	try {
		logger.debug(`Starting connection to tab ${tabId}`);
		setTabConnecting(tabId);
		await connectionManager.ensureConnection();
		await attachTab(tabId);
		logger.debug(`Successfully connected to tab ${tabId}`);
	} catch (error) {
		logger.debug(`Failed to connect to tab ${tabId}:`, error);
		const isExtensionInUse = error.message === "Extension Already In Use" || error.message === "Another Playwriter extension is already connected";
		const isWsError = error.message === "Server not available" || error.message === "Connection timeout" || error.message.startsWith("WebSocket");
		if (isExtensionInUse) {
			logger.debug(`Another extension is in use, entering polling mode`);
			store.setState((state) => {
				const newTabs = new Map(state.tabs);
				newTabs.delete(tabId);
				return {
					tabs: newTabs,
					connectionState: "extension-replaced",
					errorText: "Another Playwriter extension is actively in use"
				};
			});
		} else if (isWsError) logger.debug(`WS connection failed, keeping tab ${tabId} in connecting state for retry`);
		else {
			let tabStillExists = true;
			try {
				await chrome.tabs.get(tabId);
			} catch {
				tabStillExists = false;
			}
			if (!tabStillExists) {
				logger.debug(`Tab ${tabId} was closed during connect, dropping error state`);
				store.setState((state) => {
					const newTabs = new Map(state.tabs);
					newTabs.delete(tabId);
					return { tabs: newTabs };
				});
				return;
			}
			store.setState((state) => {
				const newTabs = new Map(state.tabs);
				newTabs.set(tabId, {
					state: "error",
					errorText: `Error: ${error.message}`
				});
				return { tabs: newTabs };
			});
		}
	}
}
function setTabConnecting(tabId) {
	store.setState((state) => {
		const newTabs = new Map(state.tabs);
		const existing = newTabs.get(tabId);
		newTabs.set(tabId, {
			...existing,
			state: "connecting"
		});
		return { tabs: newTabs };
	});
}
async function disconnectTab(tabId) {
	logger.debug(`Disconnecting tab ${tabId}`);
	const { tabs } = store.getState();
	if (!tabs.has(tabId)) {
		logger.debug("Tab not in tabs map, ignoring disconnect");
		return;
	}
	detachTab(tabId, true);
}
async function toggleExtensionForActiveTab() {
	const tab = (await chrome.tabs.query({
		active: true,
		currentWindow: true
	}))[0];
	if (!tab?.id) throw new Error("No active tab found");
	await onActionClicked(tab);
	await new Promise((resolve) => {
		const check = () => {
			if (store.getState().tabs.get(tab.id)?.state === "connecting") {
				setTimeout(check, 100);
				return;
			}
			resolve();
		};
		check();
	});
	const state = store.getState();
	return {
		isConnected: state.tabs.has(tab.id) && state.tabs.get(tab.id)?.state === "connected",
		state
	};
}
async function disconnectEverything() {
	tabGroupQueue = tabGroupQueue.then(async () => {
		const { tabs } = store.getState();
		for (const tabId of tabs.keys()) await disconnectTab(tabId);
	});
	await tabGroupQueue;
}
async function resetDebugger() {
	if (!chrome.debugger?.getTargets) return;
	let targets = await chrome.debugger.getTargets();
	targets = targets.filter((x) => x.tabId && x.attached);
	logger.log(`found ${targets.length} existing debugger targets. detaching them before background script starts`);
	for (const target of targets) await chrome.debugger.detach({ tabId: target.tabId });
}
var OUR_EXTENSION_IDS = ["jfeammnjpkecdekppnclgkkffahnhfhe", "pebbngnfojnignonigcnkdilknapkgid"];
var OUR_OWN_EXTENSION_ID = chrome.runtime.id;
function isRestrictedUrl(url) {
	if (!url) return false;
	for (const scheme of ["chrome-extension://", "moz-extension://"]) if (url.startsWith(scheme)) {
		const extensionId = url.slice(scheme.length).split("/")[0];
		if (extensionId === OUR_OWN_EXTENSION_ID || OUR_EXTENSION_IDS.includes(extensionId)) return false;
		return true;
	}
	return [
		"chrome://",
		"devtools://",
		"edge://",
		"about:",
		"https://chrome.google.com/",
		"https://chromewebstore.google.com/"
	].some((prefix) => url.startsWith(prefix));
}
var icons = {
	connected: {
		path: {
			"16": "/icons/icon-green-16.png",
			"32": "/icons/icon-green-32.png",
			"48": "/icons/icon-green-48.png",
			"128": "/icons/icon-green-128.png"
		},
		title: "Connected - Click to disconnect",
		badgeText: "",
		badgeColor: [
			64,
			64,
			64,
			255
		]
	},
	connecting: {
		path: {
			"16": "/icons/icon-gray-16.png",
			"32": "/icons/icon-gray-32.png",
			"48": "/icons/icon-gray-48.png",
			"128": "/icons/icon-gray-128.png"
		},
		title: "Waiting for MCP WS server...",
		badgeText: "...",
		badgeColor: [
			64,
			64,
			64,
			255
		]
	},
	idle: {
		path: {
			"16": "/icons/icon-black-16.png",
			"32": "/icons/icon-black-32.png",
			"48": "/icons/icon-black-48.png",
			"128": "/icons/icon-black-128.png"
		},
		title: "Click to attach debugger",
		badgeText: "",
		badgeColor: [
			64,
			64,
			64,
			255
		]
	},
	restricted: {
		path: {
			"16": "/icons/icon-gray-16.png",
			"32": "/icons/icon-gray-32.png",
			"48": "/icons/icon-gray-48.png",
			"128": "/icons/icon-gray-128.png"
		},
		title: "Cannot attach to this page",
		badgeText: "",
		badgeColor: [
			64,
			64,
			64,
			255
		]
	},
	extensionReplaced: {
		path: {
			"16": "/icons/icon-gray-16.png",
			"32": "/icons/icon-gray-32.png",
			"48": "/icons/icon-gray-48.png",
			"128": "/icons/icon-gray-128.png"
		},
		title: "Another Playwriter extension connected - Click to retry",
		badgeText: "!",
		badgeColor: [
			220,
			38,
			38,
			255
		]
	},
	tabError: {
		path: {
			"16": "/icons/icon-gray-16.png",
			"32": "/icons/icon-gray-32.png",
			"48": "/icons/icon-gray-48.png",
			"128": "/icons/icon-gray-128.png"
		},
		title: "Error",
		badgeText: "!",
		badgeColor: [
			220,
			38,
			38,
			255
		]
	}
};
async function updateIcons() {
	const { connectionState, tabs, errorText } = store.getState();
	const connectedCount = Array.from(tabs.values()).filter((t) => t.state === "connected").length;
	const allTabs = await chrome.tabs.query({});
	const tabUrlMap = new Map(allTabs.map((tab) => [tab.id, tab.url]));
	const allTabIds = [void 0, ...allTabs.map((tab) => tab.id).filter((id) => id !== void 0)];
	for (const tabId of allTabIds) {
		const tabInfo = tabId !== void 0 ? tabs.get(tabId) : void 0;
		const tabUrl = tabId !== void 0 ? tabUrlMap.get(tabId) : void 0;
		const iconConfig = (() => {
			if (connectionState === "extension-replaced") return icons.extensionReplaced;
			if (tabId !== void 0 && isRestrictedUrl(tabUrl)) return icons.restricted;
			if (tabInfo?.state === "error") return icons.tabError;
			if (tabInfo?.state === "connecting") return icons.connecting;
			if (tabInfo?.state === "connected") return icons.connected;
			return icons.idle;
		})();
		const title = (() => {
			if (connectionState === "extension-replaced" && errorText) return errorText;
			if (tabInfo?.errorText) return tabInfo.errorText;
			return iconConfig.title;
		})();
		const badgeText = (() => {
			if (iconConfig === icons.connected || iconConfig === icons.idle || iconConfig === icons.restricted) return connectedCount > 0 ? String(connectedCount) : "";
			return iconConfig.badgeText;
		})();
		browserAction.setIcon({
			tabId,
			path: iconConfig.path
		});
		browserAction.setTitle({
			tabId,
			title
		});
		if (iconConfig.badgeColor) browserAction.setBadgeBackgroundColor({
			tabId,
			color: iconConfig.badgeColor
		});
		browserAction.setBadgeText({
			tabId,
			text: badgeText
		});
	}
}
async function onTabRemoved(tabId) {
	popupSourceTabMap.delete(tabId);
	const { tabs } = store.getState();
	if (!tabs.has(tabId)) return;
	logger.debug(`Connected tab ${tabId} was closed, disconnecting`);
	await disconnectTab(tabId);
}
async function onTabActivated(activeInfo) {
	store.setState({ currentTabId: activeInfo.tabId });
}
async function onActionClicked(tab) {
	if (!tab.id) {
		logger.debug("No tab ID available");
		return;
	}
	if (isRestrictedUrl(tab.url)) {
		logger.debug("Cannot attach to restricted URL:", tab.url);
		return;
	}
	const { tabs, connectionState } = store.getState();
	const tabInfo = tabs.get(tab.id);
	if (connectionState === "extension-replaced") {
		logger.debug("Clearing extension-replaced state, attempting to reconnect");
		store.setState({
			connectionState: "idle",
			errorText: void 0
		});
		await connectTab(tab.id);
		return;
	}
	if (tabInfo?.state === "error") {
		logger.debug("Tab has error - disconnecting to clear state");
		await disconnectTab(tab.id);
		return;
	}
	if (tabInfo?.state === "connecting") {
		logger.debug("Tab is already connecting, ignoring click");
		return;
	}
	if (tabInfo?.state === "connected") await disconnectTab(tab.id);
	else await connectTab(tab.id);
}
resetDebugger();
connectionManager.maintainLoop();
Promise.resolve(chrome.contextMenus?.remove("playwriter-pin-element")).catch(() => {}).finally(() => {
	chrome.contextMenus?.create({
		id: "playwriter-pin-element",
		title: "Copy Playwriter Element Reference",
		contexts: ["all"],
		visible: false
	});
});
function updateContextMenuVisibility() {
	const { currentTabId, tabs } = store.getState();
	const isConnected = currentTabId !== void 0 && tabs.get(currentTabId)?.state === "connected";
	chrome.contextMenus?.update("playwriter-pin-element", { visible: isConnected });
}
chrome.runtime.onInstalled.addListener((details) => {
	if (details.reason === "install") chrome.tabs.create({ url: "src/welcome.html" });
});
function serializeTabs(tabs) {
	return JSON.stringify(Array.from(tabs.entries()));
}
store.subscribe((state, prevState) => {
	logger.log(state);
	updateIcons();
	updateContextMenuVisibility();
	if (serializeTabs(state.tabs) !== serializeTabs(prevState.tabs)) tabGroupQueue = tabGroupQueue.then(syncTabGroup).catch((e) => {
		logger.debug("syncTabGroup error:", e);
	});
});
logger.debug(`Using relay host: ${RELAY_HOST}, port: ${RELAY_PORT}`);
var lastMemoryUsage = 0;
var lastMemoryCheck = Date.now();
var MEMORY_WARNING_THRESHOLD = 50 * 1024 * 1024;
var MEMORY_CRITICAL_THRESHOLD = 100 * 1024 * 1024;
var MEMORY_GROWTH_THRESHOLD = 10 * 1024 * 1024;
function checkMemory() {
	try {
		const memory = performance.memory;
		if (!memory) return;
		const used = memory.usedJSHeapSize;
		const total = memory.totalJSHeapSize;
		const limit = memory.jsHeapSizeLimit;
		const now = Date.now();
		const timeDelta = now - lastMemoryCheck;
		const memoryDelta = used - lastMemoryUsage;
		const formatMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + "MB";
		const growthRate = timeDelta > 0 ? memoryDelta / timeDelta * 1e3 : 0;
		if (used > MEMORY_CRITICAL_THRESHOLD) logger.error(`MEMORY CRITICAL: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`);
		else if (used > MEMORY_WARNING_THRESHOLD) logger.warn(`MEMORY WARNING: used=${formatMB(used)} total=${formatMB(total)} limit=${formatMB(limit)} growth=${formatMB(memoryDelta)} rate=${formatMB(growthRate)}/s`);
		else if (memoryDelta > MEMORY_GROWTH_THRESHOLD && timeDelta < 6e4) logger.warn(`MEMORY SPIKE: grew ${formatMB(memoryDelta)} in ${(timeDelta / 1e3).toFixed(1)}s (used=${formatMB(used)})`);
		lastMemoryUsage = used;
		lastMemoryCheck = now;
	} catch (e) {}
}
setInterval(checkMemory, 5e3);
checkMemory();
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onActivated.addListener(onTabActivated);
browserAction.onClicked.addListener(onActionClicked);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	updateIcons();
	if (!isFirefox() && chrome.tabGroups && changeInfo.groupId !== void 0) tabGroupQueue = tabGroupQueue.then(async () => {
		const groupId = (await chrome.tabGroups.query({ title: TAB_GROUP_TITLE }))[0]?.id;
		if (groupId === void 0) return;
		const { tabs } = store.getState();
		if (changeInfo.groupId === groupId) {
			if (!tabs.has(tabId) && !isRestrictedUrl(tab.url)) {
				logger.debug("Tab manually added to playwriter group:", tabId);
				await connectTab(tabId);
			}
		} else if (tabs.has(tabId)) {
			if (tabs.get(tabId)?.state === "connecting") {
				logger.debug("Tab removed from group while connecting, ignoring:", tabId);
				return;
			}
			logger.debug("Tab manually removed from playwriter group:", tabId);
			await disconnectTab(tabId);
		}
	}).catch((e) => {
		logger.debug("onTabUpdated handler error:", e);
	});
});
var popupSourceTabMap = /* @__PURE__ */ new Map();
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
	popupSourceTabMap.set(details.tabId, details.sourceTabId);
	setTimeout(() => {
		popupSourceTabMap.delete(details.tabId);
	}, 1e4);
});
chrome.windows.onCreated.addListener(async (popupWindow) => {
	if (popupWindow.type !== "popup" || popupWindow.id === void 0) return;
	try {
		let popupTabs = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			popupTabs = await chrome.tabs.query({ windowId: popupWindow.id });
			if (popupTabs.length > 0) break;
			await sleep(20);
		}
		const tabIds = popupTabs.map((t) => t.id).filter((id) => {
			return id !== void 0;
		});
		if (tabIds.length === 0) {
			logger.debug(`Popup window ${popupWindow.id} has no tabs after retry, skipping`);
			return;
		}
		const { tabs: connectedTabs } = store.getState();
		let sourceTabId;
		for (const tabId of tabIds) {
			const candidate = popupSourceTabMap.get(tabId);
			if (candidate !== void 0 && connectedTabs.has(candidate)) {
				sourceTabId = candidate;
				break;
			}
		}
		for (const tabId of tabIds) popupSourceTabMap.delete(tabId);
		if (sourceTabId === void 0) {
			logger.debug(`Popup window ${popupWindow.id} not opened by a Playwriter-connected tab, leaving alone (tabs=${JSON.stringify(tabIds)})`);
			return;
		}
		let destinationWindowId;
		try {
			const sourceTab = await chrome.tabs.get(sourceTabId);
			if (sourceTab.windowId === void 0) {
				const focused = await chrome.windows.getLastFocused({ populate: false });
				if (focused.id === void 0 || focused.id === popupWindow.id) return;
				destinationWindowId = focused.id;
			} else destinationWindowId = sourceTab.windowId;
		} catch (e) {
			logger.debug(`Source tab ${sourceTabId} no longer exists, skipping relocation:`, e);
			return;
		}
		logger.debug(`Relocating ${tabIds.length} popup tab(s) from window ${popupWindow.id} into source window ${destinationWindowId} (sourceTabId=${sourceTabId})`);
		await chrome.tabs.move(tabIds, {
			windowId: destinationWindowId,
			index: -1
		});
		try {
			await chrome.windows.remove(popupWindow.id);
		} catch {}
		for (const tabId of tabIds) {
			if (connectedTabs.has(tabId)) continue;
			try {
				await connectTab(tabId);
			} catch (e) {
				logger.warn(`Failed to auto-connect relocated popup tab ${tabId}:`, e);
			}
		}
	} catch (e) {
		logger.warn("Failed to relocate popup window:", e);
	}
});
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId !== "playwriter-pin-element" || !tab?.id) return;
	const tabInfo = store.getState().tabs.get(tab.id);
	if (!tabInfo || tabInfo.state !== "connected") {
		logger.debug("Tab not connected, ignoring");
		return;
	}
	const debuggee = { tabId: tab.id };
	const count = (tabInfo.pinnedCount || 0) + 1;
	store.setState((state) => {
		const newTabs = new Map(state.tabs);
		const existing = newTabs.get(tab.id);
		if (existing) newTabs.set(tab.id, {
			...existing,
			pinnedCount: count
		});
		return { tabs: newTabs };
	});
	const name = `playwriterPinnedElem${count}`;
	const connectedTabs = Array.from(store.getState().tabs.entries()).filter(([_, t]) => t.state === "connected").sort((a, b) => (a[1].attachOrder ?? 0) - (b[1].attachOrder ?? 0));
	const pageIndex = connectedTabs.findIndex(([id]) => id === tab.id);
	const hasMultiplePages = connectedTabs.length > 1;
	try {
		const result = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
			expression: `
        if (window.__playwriter_lastRightClicked) {
          window.${name} = window.__playwriter_lastRightClicked;
          '${name}';
        } else {
          throw new Error('No element was right-clicked');
        }
      `,
			returnByValue: true
		});
		if (result.exceptionDetails) {
			logger.error("Failed to pin element:", result.exceptionDetails.text);
			return;
		}
		const clipboardText = hasMultiplePages ? `globalThis.${name} (page ${pageIndex}, ${tab.url || "unknown url"})` : `globalThis.${name}`;
		await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
			expression: `
        (() => {
          const el = window.${name};
          if (!el) return;
          const orig = el.getAttribute('style') || '';
          el.setAttribute('style', orig + '; outline: 3px solid #22c55e !important; outline-offset: 2px !important; box-shadow: 0 0 0 3px #22c55e !important;');
          setTimeout(() => el.setAttribute('style', orig), 300);
          return navigator.clipboard.writeText(${JSON.stringify(clipboardText)});
        })()
      `,
			awaitPromise: true
		});
		logger.debug("Pinned element as:", name);
	} catch (error) {
		logger.error("Failed to pin element:", error.message);
	}
});
updateIcons();
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
	if (message.action === "recordingChunk") {
		const { tabId, data, final } = message;
		if (connectionManager.ws?.readyState === WebSocket.OPEN) {
			sendMessage({
				method: "recordingData",
				params: {
					tabId,
					final
				}
			});
			if (data && !final) {
				const buffer = new Uint8Array(data);
				connectionManager.ws.send(buffer);
			}
		} else {
			logger.debug(`Buffering recording chunk for tab ${tabId} (WebSocket not ready)`);
			recordingChunkBuffer.push({
				tabId,
				data,
				final
			});
		}
		return false;
	}
	if (message.action === "recordingCancelled") {
		const { tabId } = message;
		getActiveRecordings().delete(tabId);
		store.setState((state) => {
			const newTabs = new Map(state.tabs);
			const existing = newTabs.get(tabId);
			if (existing) newTabs.set(tabId, {
				...existing,
				isRecording: false
			});
			return { tabs: newTabs };
		});
		if (connectionManager.ws?.readyState === WebSocket.OPEN) sendMessage({
			method: "recordingCancelled",
			params: { tabId }
		});
		return false;
	}
	return false;
});
//#endregion
