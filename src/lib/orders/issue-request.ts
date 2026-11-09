// Emissão do pedido de autorização SCR de um membro do pedido: gera o código, monta o termo e enfileira o aviso com o link.
// Usada pelo tick e pela correção de contato da equipe (updateOrderContactAction).
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";
import { generateScrCode } from "@/lib/scr/code";
import { buildScrConsentTerm } from "@/lib/scr/consent-term";
import { issueSelfScrAuthorization, type IssueSelfScrResult } from "@/lib/scr/queries";
import type { ScrTermSettings } from "@/lib/settings/readers";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

import type { ScrRequestToIssue } from "./tick-queries";

export async function issueRequest(
	identity: DbIdentity,
	request: ScrRequestToIssue,
	term: ScrTermSettings,
	siteUrl: string,
): Promise<IssueSelfScrResult> {
	const document = request.type === "PJ" ? formatCNPJ(request.document) : formatCPF(request.document);
	const consent = buildScrConsentTerm({
		authorizedName: term.authorizedName,
		authorizedDocument: term.authorizedDocument || undefined,
		institutionName: term.institutionName,
		clientName: request.name,
		document,
		city: term.city,
		date: formatDate(new Date()),
	});
	const issued = await issueSelfScrAuthorization(identity, request.scrId, {
		code: generateScrCode(),
		email: request.email,
		consentText: consent.fullText,
		consentName: request.name,
		consentDocument: document,
		notification: {
			recipient: request.email,
			clientName: request.name,
			authorizedName: term.authorizedName,
			siteUrl,
			phone: request.phoneE164,
		},
	}, { publicToken: request.publicToken });
	if (issued.ok) {
		await withUserTransaction(identity, (client) =>
			recordHolderEvent(client, identity.userId, request.holderId, {
				eventType: "scr.requested",
				title: "Pedido de autorização SCR enviado",
			}),
		);
	}
	return issued;
}
