import { Link } from 'react-router-dom';

export default function Legal() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed">
      <Link to="/" className="text-accent">← VideoAI Studio</Link>
      <h1 className="mt-4 font-display text-2xl font-semibold">Termos de uso e política de uso aceitável</h1>
      <p className="mt-2 text-muted">Versão inicial — revise com um profissional jurídico antes do lançamento comercial.</p>

      <h2 className="mt-6 font-semibold">1. Conteúdo enviado</h2>
      <p>Você declara ser titular ou ter autorização para usar e modificar todo vídeo, imagem e áudio que enviar, inclusive os direitos de imagem e de voz das pessoas que aparecem neles. Os arquivos pertencem a você e ficam em armazenamento privado.</p>

      <h2 className="mt-6 font-semibold">2. Usos proibidos</h2>
      <ul className="list-disc pl-5">
        <li>Fraude, falsificação enganosa ou desinformação, inclusive fazer conteúdo sintético passar por real para enganar.</li>
        <li>Assédio, difamação, discurso de ódio ou exploração de terceiros.</li>
        <li>Conteúdo sexual envolvendo pessoas reais sem consentimento, ou qualquer conteúdo sexual envolvendo menores.</li>
        <li>Reproduzir a identidade ou clonar a voz de pessoas reais sem autorização expressa.</li>
        <li>Violar direitos autorais, de imagem, privacidade ou as políticas das plataformas onde o conteúdo será publicado.</li>
      </ul>

      <h2 className="mt-6 font-semibold">3. Conteúdo sintético</h2>
      <p>Arquivos gerados ou alterados por IA são marcados como tal na plataforma e recebem identificação nos metadados quando tecnicamente possível. Recomendamos informar ao público quando um vídeo usa IA, conforme as regras de cada rede social.</p>

      <h2 className="mt-6 font-semibold">4. Provedores de IA</h2>
      <p>O processamento usa serviços de terceiros (como Runway e Anthropic), que recebem os arquivos e textos necessários para cada tarefa e aplicam suas próprias políticas de moderação e retenção. Resultados podem variar; a consistência perfeita de personagens não é garantida.</p>

      <h2 className="mt-6 font-semibold">5. Créditos</h2>
      <p>O custo estimado é exibido antes de cada tarefa. É cobrado o custo real até o valor estimado; tarefas que falham são reembolsadas conforme a política vigente exibida na plataforma.</p>

      <h2 className="mt-6 font-semibold">6. Privacidade (LGPD)</h2>
      <p>Coletamos e-mail, nome e os arquivos que você envia, apenas para prestar o serviço. Arquivos temporários são apagados automaticamente. Você pode excluir arquivos a qualquer momento e solicitar a exclusão total da conta em "Minha conta".</p>
    </div>
  );
}
