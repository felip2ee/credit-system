import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const SPLIT_STATUS_OPTIONS = [
	["pending", "Pendente"],
	["done", "Repassado"],
	["refused", "Recusado"],
	["refunded", "Estornado"],
	["reversal_failed", "Reversão falhou"],
] as const;

interface ReportFiltersProps {
	fromDate: string;
	toDate: string;
	status?: string;
}

// Formulário GET: o período e o status vão na URL, então a página segue como Server Component.
export function ReportFilters({ fromDate, toDate, status }: ReportFiltersProps) {
	return (
		<form method="get" className="flex flex-wrap items-end gap-3">
			<div className="space-y-1">
				<Label htmlFor="report-de">De</Label>
				<Input id="report-de" name="de" type="date" defaultValue={fromDate} />
			</div>
			<div className="space-y-1">
				<Label htmlFor="report-ate">Até</Label>
				<Input id="report-ate" name="ate" type="date" defaultValue={toDate} />
			</div>
			<div className="space-y-1">
				<Label htmlFor="report-status">Status do repasse</Label>
				<select
					id="report-status"
					name="status"
					defaultValue={status ?? ""}
					className="flex h-12 admin:h-10 admin:text-sm rounded-input border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<option value="">Todos</option>
					{SPLIT_STATUS_OPTIONS.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</div>
			<Button type="submit" variant="outline">
				Filtrar
			</Button>
		</form>
	);
}
