/** Coalesce work per folder and let asynchronous writes finish before starting more. */
export class FolderWorkQueue {
	private readonly pending = new Map<string, number>();
	private timer: number | null = null;
	private running = false;
	private disposed = false;

	constructor(private readonly update: (path: string) => Promise<void>) {}

	schedule(path: string, delay: number): void {
		if (this.disposed || !path) return;
		this.pending.set(path, Math.max(this.pending.get(path) ?? 0, Date.now() + delay));
		this.arm();
	}

	dispose(): void {
		this.disposed = true;
		this.pending.clear();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private arm(): void {
		if (this.disposed || this.running) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (this.pending.size === 0) return;
		const next = Math.min(...this.pending.values());
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, Math.max(0, next - Date.now()));
	}

	private async flush(): Promise<void> {
		this.running = true;
		try {
			while (!this.disposed) {
				const ready = [...this.pending].find(([, due]) => due <= Date.now());
				if (!ready) break;
				this.pending.delete(ready[0]);
				await this.update(ready[0]);
			}
		} finally {
			this.running = false;
			this.arm();
		}
	}
}
