# Ritmo

Extensão para transformar os labels do Google Agenda em uma visão clara de carga, categorias e capacidade semanal.

## O que já funciona

- dashboard semanal com navegação entre semanas;
- soma do tempo por label do Google Agenda;
- agrupamento automático dos labels iniciados por `Imprevistos`;
- visão por dia, categoria e compromisso;
- tela de comparação entre a semana selecionada e a semana anterior;
- cálculo de capacidade e espaço disponível;
- disponibilidade calculada pelos intervalos realmente livres dentro da jornada, sem duplicar eventos sobrepostos;
- insights automáticos sobre reuniões, imprevistos e dias carregados;
- configuração de dias, horários por período e eventos de dia inteiro;
- sugestão de jornada baseada nos compromissos das últimas oito semanas;
- exclusão automática de eventos recusados no Google Agenda;
- cache local dos dados da última sincronização.
- resumo compacto ao clicar no ícone, com acesso ao dashboard completo.
- identidade visual da Next Fit no ícone da extensão e nas abas do navegador.

## Instalação local

1. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione esta pasta.
5. Clique no ícone da extensão para abrir o resumo semanal.
6. Use **Abrir análise completa** para acessar o dashboard.

## Conectar o Google Agenda

1. Crie ou selecione um projeto no [Google Cloud Console](https://console.cloud.google.com/).
2. Ative a **Google Calendar API**.
3. Configure a tela de consentimento OAuth.
4. Copie o ID da extensão exibido em `chrome://extensions`.
5. Crie uma credencial OAuth do tipo **Extensão do Chrome** usando esse ID.
6. Abra `manifest.json` e substitua:

   ```text
   COLOQUE_SEU_CLIENT_ID.apps.googleusercontent.com
   ```

   pelo Client ID fornecido pelo Google.

7. Na página de extensões, clique em **Recarregar**.
8. Abra o Ritmo e clique em **Conectar Google Agenda**.

A extensão solicita somente o escopo `calendar.readonly`. Ela não cria, altera ou exclui eventos.

## Como a classificação funciona

O Ritmo lê `eventLabelId` dos eventos e cruza o valor com os labels personalizados de `labelProperties.eventLabels`. As chamadas usam `eventLabelVersion=1`, conforme a API atual do Google Calendar.

Os labels são exibidos individualmente na tabela. Para a visão consolidada, qualquer label cujo nome comece com `Imprevisto` ou `Imprevistos` entra também no macrogrupo **Imprevistos**.

## Privacidade

Não há servidor ou banco de dados. Preferências e o cache da última sincronização ficam em `chrome.storage.local`, no próprio navegador. O token OAuth é administrado pela API `chrome.identity` do navegador.
