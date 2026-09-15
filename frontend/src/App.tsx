import { useState } from 'react';
import { ProvedorSessao, useSessao } from './auth/sessao';
import { pode } from './auth/permissoes';
import { Layout, type Tela } from './componentes/Layout';
import { Dashboard } from './telas/Dashboard';
import { Agenda } from './telas/Agenda';
import { Inbox } from './telas/Inbox';
import { Login } from './telas/Login';

function Aplicacao() {
  const { sessao } = useSessao();
  // Cada papel aterrissa na primeira tela que ele realmente pode usar:
  // Owner/Admin no dashboard, Atendente e Read Only direto na agenda.
  // Ninguém entra numa tela de "acesso negado".
  const [tela, setTela] = useState<Tela | null>(null);

  if (!sessao) return <Login />;

  const inicial: Tela = pode(sessao.papel, 'ver_dashboard') ? 'dashboard' : 'agenda';
  const telaEscolhida = tela ?? inicial;

  const telaEfetiva: Tela =
    telaEscolhida === 'dashboard' && !pode(sessao.papel, 'ver_dashboard')
      ? 'agenda'
      : telaEscolhida;

  return (
    <Layout telaAtual={telaEfetiva} aoNavegar={setTela}>
      {telaEfetiva === 'dashboard' && <Dashboard aoIrPara={setTela} />}
      {telaEfetiva === 'agenda' && <Agenda />}
      {telaEfetiva === 'inbox' && <Inbox />}
    </Layout>
  );
}

export function App() {
  return (
    <ProvedorSessao>
      <Aplicacao />
    </ProvedorSessao>
  );
}
