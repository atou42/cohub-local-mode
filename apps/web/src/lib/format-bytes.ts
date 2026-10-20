const UNITS = ["B", "KB", "MB", "GB"] as const;

/** Human-readable byte size. Non-positive or non-finite input reads as "0 B". */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const index = Math.min(
		UNITS.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** index;
	return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[index]}`;
}

/** Like {@link formatBytes} but rounds whole units, e.g. "2 GB" for a 2 GiB limit. */
export function formatByteLimit(bytes: number): string {
	return formatBytes(bytes).replace(/\.0 /, " ");
}
