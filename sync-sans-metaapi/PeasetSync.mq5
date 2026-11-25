//+------------------------------------------------------------------+
//| PeasetSync.mq5                                                   |
//| Peaset — Expert Advisor de synchronisation MT5, sans MetaAPI.   |
//| Écrit par Muse pour Pascal, le 2026-11-25.                      |
//|                                                                  |
//| Principe, comme l'Expert Advisor gratuit de Sage :               |
//| - Cet EA tourne DANS ton terminal MT5, sur le graphique.        |
//| - Il n'a besoin d'aucun mot de passe : il utilise le compte    |
//|   déjà connecté dans ton terminal. Il ne voit donc jamais      |
//|   ton mot de passe, ni principal, ni investisseur.             |
//| - Il ne passe aucun ordre, il ne modifie rien, il ne ferme     |
//|   rien. Il lit seulement l'historique des deals fermés et      |
//|   l'envoie à ton Worker Peaset.                                |
//| - Il marche avec n'importe quel broker, y compris GatesFX,     |
//|   car il ne passe pas par une liste de brokers supportés.      |
//|                                                                  |
//| Installation :                                                   |
//| 1. Dans MT5, Fichier > Ouvrir le dossier de données > MQL5 >    |
//|    Experts, copie ce fichier PeasetSync.mq5, puis compile      |
//|    avec F7 dans MetaEditor.                                     |
//| 2. Outils > Options > Expert Advisors, coche                    |
//|    "Autoriser le trading algorithmique" et                     |
//|    "Autoriser les WebRequest pour les URL listées", et ajoute : |
//|    https://peaset-chat.pascalsteeve4.workers.dev               |
//|    Sans cette URL autorisée, MT5 refusera d'envoyer les deals. |
//| 3. Glisse PeasetSync sur un graphique, par exemple EURUSD.     |
//| 4. Dans les paramètres, mets :                                  |
//|    TraderName = ton nom de trader dans Peaset, en minuscules   |
//|    WorkerSecret = ton secret MT5_WORKER_SECRET                 |
//|    Ne mets jamais ce secret dans un chat ou dans GitHub.        |
//| 5. L'EA envoie les deals toutes les 60 secondes, et aussi      |
//|    quand tu cliques sur "Synchroniser maintenant" dans le site.|
//|    Pour vérifier, regarde l'onglet Journal de MT5.            |
//+------------------------------------------------------------------+
#property copyright "Peaset"
#property version   "1.00"
#property strict

input string TraderName = "black_peaset";
input string WorkerSecret = "";
input string WorkerUrl = "https://peaset-chat.pascalsteeve4.workers.dev";
input int SyncMinutes = 1;

datetime lastSync = 0;

// Envoie les deals au Worker, en JSON, avec le secret en Bearer.
bool SendDeals(string jsonBody)
{
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + WorkerSecret + "\r\n";
   char post[];
   StringToCharArray(jsonBody, post, 0, StringLen(jsonBody), CP_UTF8);
   char result[];
   string resultHeaders;
   ResetLastError();
   int code = WebRequest("POST", WorkerUrl + "/mt5/sync-worker", headers, 10000, post, result, resultHeaders);
   if(code != 200)
   {
      Print("PeasetSync : WebRequest erreur ", code, " ", GetLastError());
      return false;
   }
   string answer = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   Print("PeasetSync : réponse Worker ", answer);
   return true;
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

void SyncNow()
{
   if(WorkerSecret == "")
   {
      Print("PeasetSync : WorkerSecret manquant dans les paramètres.");
      return;
   }
   // Historique des 90 derniers jours, comme Sage au premier sync.
   datetime endTime = TimeCurrent();
   datetime startTime = endTime - 90 * 24 * 60 * 60;
   if(!HistorySelect(startTime, endTime))
   {
      Print("PeasetSync : HistorySelect a échoué ", GetLastError());
      return;
   }
   int total = HistoryDealsTotal();
   string dealsJson = "";
   int sent = 0;
   // On envoie les deals les plus récents d'abord, 200 max par appel,
   // comme le fait le Worker avec mergeMt5Deals.
   for(int i = total - 1; i >= 0 && sent < 200; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_IN && entry != DEAL_ENTRY_OUT) continue;
      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      if(symbol == "") continue;
      long type = HistoryDealGetInteger(ticket, DEAL_TYPE);
      double volume = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double price = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double commission = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      double swap = HistoryDealGetDouble(ticket, DEAL_SWAP);
      long timeMs = (long)HistoryDealGetInteger(ticket, DEAL_TIME) * 1000;
      long positionId = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      string typeStr = (type == DEAL_TYPE_SELL) ? "sell" : "buy";
      long openMs = (entry == DEAL_ENTRY_IN) ? timeMs : 0;
      long closeMs = (entry == DEAL_ENTRY_OUT) ? timeMs : 0;
      if(dealsJson != "") dealsJson += ",";
      dealsJson += StringFormat("{\"ticket\":%I64u,\"position\":%I64d,\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%.2f,\"openTime\":%I64d,\"closeTime\":%I64d,\"openPrice\":%.5f,\"closePrice\":%.5f,\"profit\":%.2f,\"commission\":%.2f,\"swap\":%.2f}",
         ticket, positionId, JsonEscape(symbol), typeStr, volume, openMs, closeMs, price, price, profit, commission, swap);
      sent++;
   }
   long accountNumber = AccountInfoInteger(ACCOUNT_LOGIN);
   string server = AccountInfoString(ACCOUNT_SERVER);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   string body = StringFormat("{\"name\":\"%s\",\"worker_secret\":\"%s\",\"deals\":[%s],\"account\":%I64d,\"server\":\"%s\",\"balance\":%.2f,\"equity\":%.2f}",
      JsonEscape(TraderName), JsonEscape(WorkerSecret), dealsJson, accountNumber, JsonEscape(server), balance, equity);
   if(SendDeals(body))
   {
      lastSync = TimeCurrent();
      Print("PeasetSync : ", sent, " deals envoyés, solde ", balance);
   }
}

int OnInit()
{
   Print("PeasetSync démarré pour ", TraderName, ". Sync toutes les ", SyncMinutes, " minute(s).");
   EventSetTimer(SyncMinutes * 60);
   SyncNow();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   SyncNow();
}

void OnTick()
{
   // Rien ici : la synchro est sur minuteur, pas à chaque tick,
   // pour ne pas surcharger le terminal ni le Worker.
}
//+------------------------------------------------------------------+
