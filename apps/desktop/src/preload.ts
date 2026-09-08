import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cohubDesktop", {
	signIn: () => ipcRenderer.invoke("cohub-desktop:sign-in"),
	getStatus: () => ipcRenderer.invoke("cohub-desktop:status"),
	onStatus: (callback: (status: unknown) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
		ipcRenderer.on("cohub-desktop:status", listener);
		return () => ipcRenderer.removeListener("cohub-desktop:status", listener);
	},
	retry: () => ipcRenderer.invoke("cohub-desktop:retry"),
	diagnostics: () => ipcRenderer.invoke("cohub-desktop:diagnostics"),
	quit: () => ipcRenderer.invoke("cohub-desktop:quit"),
});
