//+------------------------------------------------------------------+
//| PeasetPositions.mq5 — Positions ouvertes Peaset, sans MetaAPI     |
//| Envoie les positions ouvertes à Peaset toutes les 60 secondes.     |
//| Pas de mot de passe : utilise le terminal MT5 déjà connecté.       |
//|                                                                      |
//| Installation :                                                       |
//| 1. Copie ce fichier dans MQL5/Experts/ dans ton MT5 (Windows).       |
//| 2. Dans MT5 : Outils > Options > Expert Advisors >                  |
//|    coche "Autoriser WebRequest" et ajoute :                         |
//|    https://peaset-chat.pascalsteeve4.workers.dev                   |
//| 3. Glisse l'EA sur un graphique, mets :                             |
//|    TraderName = ton nom Peaset (ex. Black_peaset)                    |
//|    WorkerSecret = ton secret MT5_WORKER_SECRET (celui du Worker)     |
//| 4. L'EA envoie tes positions ouvertes toutes les 60 secondes.        |
//|    Quand tu fermes toutes tes positions, la liste devient vide.     |
//+------------------------------------------------------------------+
#property copyright "Peaset — positions ouvertes, sans MetaAPI"
#property version   "1.00"
#property strict

input string TraderName   = "Black_peaset";
input string WorkerSecret = "";
input string WorkerUrl    = "https://peaset-chat.pascalsteeve4.workers.dev/mt5/positions-worker";
input int    SyncMinutes  = 1;

datetime lastSync = 0;

int OnInit()
{
   EventSetTimer(60);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(TimeCurrent() - lastSync < SyncMinutes * 60) return;
   SendPositions();
}

void SendPositions()
{
   if(StringLen(TraderName) == 0 || StringLen(WorkerSecret) == 0) return;

   string pos = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string symbol = PositionGetString(POSITION_SYMBOL);
      long type = PositionGetInteger(POSITION_TYPE);
      double volume = PositionGetDouble(POSITION_VOLUME);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double curPrice = PositionGetDouble(POSITION_PRICE_CURRENT);
      double profit = PositionGetDouble(POSITION_PROFIT);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      long openTime = PositionGetInteger(POSITION_TIME);

      if(StringLen(pos) > 0) pos += ",";
      pos += StringFormat(
         "{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%.2f,\"openTime\":%I64d,\"openPrice\":%.5f,\"currentPrice\":%.5f,\"profit\":%.2f,\"sl\":%.5f,\"tp\":%.5f}",
         ticket, symbol, (type == POSITION_TYPE_SELL ? "sell" : "buy"),
         volume, openTime * 1000, openPrice, curPrice, profit, sl, tp);
   }

   string body = StringFormat(
      "{\"name\":\"%s\",\"account\":{\"login\":%I64d,\"server\":\"%s\"},\"positions\":[%s]}",
      TraderName, AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER), pos);

   char data[];
   StringToCharArray(body, data, 0, StringLen(body));
   char result[];
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + WorkerSecret + "\r\n";
   string resultHeaders;
   int res = WebRequest("POST", WorkerUrl, headers, 10000, data, result, resultHeaders);
   if(res == 200) lastSync = TimeCurrent();
}
