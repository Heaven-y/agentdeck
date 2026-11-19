import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { LocalSessionGate } from './app/LocalSessionGate';
import { startChatConnection, useChat } from './features/chat/state/chat-store';
import { queryClient } from './lib/query-client';
import './styles.css';
import './ui/interactions.css';

const mountApp = () => (
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
function startApp() {
  void useChat.getState().readPermissionDefaults();
  startChatConnection();
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocalSessionGate start={startApp} mountApp={mountApp} />
  </StrictMode>,
);
