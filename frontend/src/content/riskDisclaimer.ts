import { UILanguage } from '../i18n';

export const RISK_DISCLAIMER_VERSION = '2026-07-07-2';

export type RiskDisclaimerSection = {
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

export type RiskDisclaimerContent = {
  title: string;
  updatedAt: string;
  intro: string;
  sections: RiskDisclaimerSection[];
  closing: string;
};

const RU: RiskDisclaimerContent = {
  title: 'Уведомление о рисках',
  updatedAt: '7 июля 2026',
  intro:
    'BattleToads — программная платформа для торговли криптовалютами. Регистрируясь, вы подтверждаете, что понимаете риски, описанные ниже.',
  sections: [
    {
      title: 'Стратегии и торговые системы',
      paragraphs: [
        'На платформе представлены торговые стратегии и торговые системы (ТС). Их показ в кабинете, витрине или демо-данных не является обещанием прибыли и не гарантирует доходность в будущем.',
        'Платформа ориентирована на системный поиск результата в долгосрочной перспективе, но фактический итог полностью зависит от рынка, выбранных настроек и условий исполнения.',
      ],
    },
    {
      title: 'Рыночные риски',
      paragraphs: [
        'Криптовалютный рынок волатилен. Возможны убытки, просадки и потеря части или всего капитала. Прошлые результаты, бэктесты и статистика не гарантируют будущую доходность.',
      ],
    },
    {
      title: 'Риски бирж и контрагентов',
      paragraphs: [
        'Сделки исполняются на сторонних биржах через ваши API-ключи. Платформа не является биржей, брокером или хранителем средств.',
        'Возможны риски взлома, банкротства или недобросовестных действий биржи, блокировки вывода, сбоев API и иных проблем со стороны контрагента.',
      ],
    },
    {
      title: 'Ответственность',
      paragraphs: [
        'Вы принимаете торговые решения и используете сервис на свой страх и риск. Платформа, её владельцы и разработчики не несут ответственности за убытки, упущенную выгоду и иные финансовые последствия, связанные с торговлей, рынком или действиями бирж.',
        'Если вы не согласны с этим — не регистрируйтесь и не используйте платформу.',
      ],
    },
  ],
  closing:
    'Галочка при регистрации означает, что вы прочитали и принимаете настоящее уведомление.',
};

const EN: RiskDisclaimerContent = {
  title: 'Risk Disclosure',
  updatedAt: 'July 7, 2026',
  intro:
    'BattleToads is a software platform for crypto trading. By registering, you confirm that you understand the risks below.',
  sections: [
    {
      title: 'Strategies and trading systems',
      paragraphs: [
        'The platform presents trading strategies and trading systems. Their display in the cabinet, storefront, or demo data is not a profit promise and does not guarantee future returns.',
        'The platform aims for systematic long-term results, but actual outcomes depend entirely on the market, your settings, and execution conditions.',
      ],
    },
    {
      title: 'Market risks',
      paragraphs: [
        'Crypto markets are volatile. Losses, drawdowns, and partial or total capital loss are possible. Past results, backtests, and statistics do not guarantee future performance.',
      ],
    },
    {
      title: 'Exchange and counterparty risks',
      paragraphs: [
        'Trades are executed on third-party exchanges via your API keys. The platform is not an exchange, broker, or custodian.',
        'Risks include exchange hacks, insolvency, fraud, withdrawal freezes, API failures, and other counterparty issues.',
      ],
    },
    {
      title: 'Liability',
      paragraphs: [
        'You make trading decisions and use the service at your own risk. The platform, its owners, and developers are not liable for losses, lost profits, or other financial consequences related to trading, market moves, or exchange actions.',
        'If you do not agree, do not register or use the platform.',
      ],
    },
  ],
  closing:
    'Checking the box at registration means you have read and accept this disclosure.',
};

const TR: RiskDisclaimerContent = {
  title: 'Risk Bildirimi',
  updatedAt: '7 Temmuz 2026',
  intro:
    'BattleToads, kripto islemleri icin bir yazilim platformudur. Kayit olarak asagidaki riskleri anladiginizi onaylarsiniz.',
  sections: [
    {
      title: 'Stratejiler ve ticaret sistemleri',
      paragraphs: [
        'Platformda ticaret stratejileri ve ticaret sistemleri sunulur. Bunlarin gosterimi kar vaadi veya gelecek getiri garantisi degildir.',
        'Platform uzun vadeli sistematik sonuc hedefler, ancak gercek sonuc tamamen piyasaya, ayarlara ve yurutme kosullarina baglidir.',
      ],
    },
    {
      title: 'Piyasa riskleri',
      paragraphs: [
        'Kripto piyasalari oynaktir. Zarar, drawdown ve sermaye kaybi mumkundur. Gecmis sonuclar gelecek performansi garanti etmez.',
      ],
    },
    {
      title: 'Borsa ve karsi taraf riskleri',
      paragraphs: [
        'Islemler API anahtarlariniz uzerinden ucuncu taraf borsalarda gerceklesir. Platform borsa, broker veya saklayici degildir.',
        'Hack, iflas, dolandiricilik, cekim dondurma ve API arizalari gibi riskler vardir.',
      ],
    },
    {
      title: 'Sorumluluk',
      paragraphs: [
        'Islem kararlarini siz verirsiniz ve hizmeti kendi riskinizle kullanirsiniz. Platform ve operatorleri islem zararlari icin sorumlu degildir.',
        'Kabul etmiyorsaniz kayit olmayin.',
      ],
    },
  ],
  closing:
    'Kayitta isaretlemek bu bildirimi okudugunuz ve kabul ettiginiz anlamina gelir.',
};

export const RISK_DISCLAIMER_CONTENT: Record<UILanguage, RiskDisclaimerContent> = {
  ru: RU,
  en: EN,
  tr: TR,
};

export const getRiskDisclaimerContent = (language: UILanguage): RiskDisclaimerContent =>
  RISK_DISCLAIMER_CONTENT[language] || RISK_DISCLAIMER_CONTENT.ru;
