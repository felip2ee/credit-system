"use client";

import { Download, Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { downloadPdf } from "./pdf-download";

function clickAnchor(url: string, filename: string): void {
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
}

export function PdfDownloadButton({ href }: { href: string }) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busy = useRef(false);

	async function onClick() {
		if (busy.current) return;
		busy.current = true;
		setLoading(true);
		setError(null);
		const result = await downloadPdf(href, {
			fetchFn: (input, init) => fetch(input, init),
			nav: {
				canShare: navigator.canShare?.bind(navigator),
				share: navigator.share?.bind(navigator),
			},
			createObjectURL: (blob) => URL.createObjectURL(blob),
			revokeObjectURL: (url) => URL.revokeObjectURL(url),
			clickAnchor,
			setTimer: (fn, ms) => setTimeout(fn, ms),
		});
		if (result.kind === "error") setError(result.message);
		busy.current = false;
		setLoading(false);
	}

	return (
		<div className="flex flex-col gap-2">
			<Button type="button" glow className="w-full sm:w-auto" onClick={onClick} disabled={loading} aria-busy={loading}>
				{loading ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
				{loading ? "Gerando PDF..." : "Baixar PDF"}
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
