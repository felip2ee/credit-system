-- Renomeia o produto do catálogo dossie_empresarial para "Dossiê Empresarial".
-- Só troca o nome semeado (010). Nome já editado pelo superadmin não é tocado, e rodar de novo não faz nada.
-- O nome do produto é lido por join (products.name) nas views e relatórios; nenhum pedido guarda cópia dele.
update products
   set name = 'Dossiê Empresarial'
 where code = 'dossie_empresarial'
   and name = 'Dossiê Empresarial Estruturado';
