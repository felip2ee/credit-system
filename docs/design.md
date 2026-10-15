# Design e acessibilidade

## Direção

- Público: equipe de Bureaus (superadmin, admin, operador) e clientes PF/PJ. Veja [PRODUCT.md](../PRODUCT.md).
- Idioma: pt-BR em textos de interface, erros e comentários. Identificadores ficam em inglês.
- Dispositivos: a interface é web. (hipótese) Uso principal em desktop para a equipe e em celular para o cliente. Nenhuma pesquisa confirma isso.
- Tom visual: o projeto usa o tema shadcn com paleta própria (primária dourada, texto verde escuro sobre a primária). Não há guia de marca documentado.
- Sem white-label: a marca da plataforma vale em interface, e-mails e PDFs.

## Sistema existente

Não há design system documentado além do shadcn/ui.

- Primitivos em `src/components/ui/`: `button`, `badge`, `card`, `table`, `input`, `label`.
- Configuração do shadcn: `components.json` (estilo `default`, cor base `slate`, variáveis CSS, ícones lucide).
- Tokens: variáveis CSS em `src/app/globals.css` (modo claro e `.dark`), mapeadas em `tailwind.config.ts` (Tailwind 3.4, `darkMode: ["class"]`). Esses dois arquivos são a fonte de verdade; não copie valores aqui.
- Utilitário `cn()` em `src/lib/utils.ts`. Variantes usam `cva`.
- Componentes de funcionalidade ficam em pastas por área (`holders/`, `dossiers/`, `consultations/`, `scr/`, `wallet/`, `notifications/` e outras). Convenções: [src/components/CLAUDE.md](../src/components/CLAUDE.md).
- Regras: nome de arquivo em kebab-case; um componente exportado por arquivo; `"use client"` só com hooks ou handlers. Adicione primitivos novos em `ui/`; não crie botão ou input à mão.
- Fonte tipográfica: variável CSS `--font-sans`, definida no layout.

## Interação

Use HTML semântico, navegação por teclado, foco visível e contraste adequado. Dê nome a controles e campos. Erros de validação ficam junto do campo; operações assíncronas exibem espera e resultado. Respeite movimento reduzido.

## Layout e revisão

- Breakpoints: os padrões do Tailwind. O contêiner usa `padding: 2rem` e largura máxima de 1400px em `2xl`.
- Estados: formulários mostram erro do servidor com `text-destructive`. Botões de envio mostram "Salvando..." durante a ação. Status usam `Badge`.
- Filtros guardam o estado na URL.
- Revisão de interface: nenhuma revisão formal de acessibilidade ou de celular está registrada. O modo escuro existe nos tokens; (hipótese) nenhuma tela foi verificada nele.
- Não existe teste automático de acessibilidade. O e2e cobre só autenticação (`e2e/auth.spec.ts`).

## Manutenção

Mudanças visuais e de interação atualizam a fonte de tokens/componentes e esta orientação quando houver alteração de regra. Consulte as skills de UI instaladas nas revisões pertinentes.
