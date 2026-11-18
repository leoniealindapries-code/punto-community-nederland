# Punto Community Nederland: installatie met Supabase

Dit is een besloten web-app voor de groepsapp, met vijf tabs:
- **Kaart:** profielfoto's van leden op hun wijk
- **Meets:** met een automatisch voorgestelde meetplek
- **Chat**
- **Instellingen:** profielfoto, gebruikersnaam, wijk en zichtbaarheid
- **Beheer:** voor de beheerder

De app draait op **GitHub Pages**. De gegevens en het inloggen lopen via **Supabase**.

Zolang `js/config.js` niet is ingevuld, draait de app in **demomodus** met nepleden.

---

## 1. Supabase-project maken
1. Ga naar **https://supabase.com** en klik op **Start your project**. Je kunt inloggen met je GitHub-account.
2. Klik op **New project**:
   - Naam: `punto-community-nl`
   - **Database Password**: verzin een sterk wachtwoord en bewaar het goed
   - **Region**: kies een regio in Europa, bijvoorbeeld **West EU (Ireland)** of **Central EU (Frankfurt)**
3. Klik op **Create new project** en wacht een paar minuten.

## 2. Database inrichten (één keer plakken)
1. Open op GitHub het bestand **supabase.sql** en klik op het icoontje **Copy raw file**.
2. Klik in Supabase links op **SQL Editor** en daarna op **New query**.
3. Plak de tekst (**Ctrl + V**) en klik rechtsonder op **Run**.
4. Vraagt Supabase of je zeker weet dat je "destructive operations" wilt uitvoeren? Klik dan op **Run this query**. Dat is veilig: het script ruimt alleen eigen oude regels op.
5. Je moet nu **Success. No rows returned** zien.

## 3. Inloggen instellen
1. Ga naar **Authentication → Sign In / Providers → Email** en zet **Confirm email** **uit**. Klik op **Save**.
   *Waarom? De gratis mailservice van Supabase kan maar een paar mails per uur versturen. Er komt toch niemand binnen zonder de groepscode én jouw goedkeuring.*
2. Ga naar **Authentication → URL Configuration**:
   - **Site URL**: `https://leoniealindapries-code.github.io/punto-community-nederland/`
   - Voeg bij **Redirect URLs** hetzelfde adres toe.

   Dit is nodig voor de knop **Wachtwoord vergeten**.

## 4. App koppelen
1. Klik bovenaan in Supabase op **Connect**, of ga naar **Project Settings → Data API**, en kopieer de **Project URL**. Die ziet eruit als `https://abcdefgh.supabase.co`.
2. Ga naar **Project Settings → API Keys** en kopieer de **Publishable key**. Die begint met `sb_publishable_`.
   **Let op:** gebruik nooit de *secret key*.
3. Open op GitHub het bestand `js/config.js` en klik op het **potloodje ✏️**.
4. Vervang de twee `VUL_IN` door de Project URL en de publishable key. Laat de aanhalingstekens staan.
5. Klik op **Commit changes**.

## 5. Jezelf beheerder maken
1. Wacht 1 tot 2 minuten en open de app. Er staat nu geen DEMO-label meer.
2. Kies **Account maken** en vul je e-mailadres en een wachtwoord in.
3. Open in Supabase de **SQL Editor** met een **New query** en plak dit, met jouw eigen e-mailadres:
   ```sql
   insert into admins (user_id) select id from auth.users where email = 'jouw@email.nl';
   ```
   Klik daarna op **Run**.
4. Ververs de app en kies een gebruikersnaam. Laat het veld voor de groepscode leeg. Je bent nu direct binnen en ziet de tab **Beheer**.

## 6. Inrichten en delen
1. **Beheer → Groepscode**: kies een code, bijvoorbeeld `PUNTO2026`.
2. **Beheer → Startlijst laden**: controleer de meetplekken met **Toon**. Sleep de speld waar nodig en klik op **Klopt**.
3. Stel in **Instellingen** je profielfoto, gebruikersnaam en wijk in.
4. Deel de link en de groepscode in de WhatsApp-groep.
5. Keur aanvragen goed in **Beheer → Toelaten**.

---

## Hoe werkt het?
- **Woonwijk:** iedereen zoekt zijn wijk of buurt op in de officiële lijst van de overheid (PDOK). Straten en adressen kun je niet invullen.
- **Onzichtbaar:** wie onzichtbaar is, staat niet op de kaart. Bij een meet telt zijn of haar wijk wel mee. De database rekent het midden zelf uit, dus de wijk van een onzichtbaar lid komt nooit op de telefoon van iemand anders. Het midden wordt afgerond op ongeveer 5 km, zodat niemand een wijk kan terugrekenen.
- **Meetplek:** de app kiest de dichtstbijzijnde McDonald's, parkeerplaats of het dichtstbijzijnde industrieterrein bij het midden. Met **Zoek live** zoekt hij ook in OpenStreetMap. Wie niet komt, telt niet mee.
- **Route:** tik op de gekozen meetplek (🏁 of de groene kaart), dan opent Google Maps.
- **Beveiliging:** alleen goedgekeurde leden kunnen iets lezen of schrijven. Leden kunnen zichzelf niet goedkeuren en zich niet voordoen als een ander.

## Goed om te weten
- **Pauzeren:** een gratis Supabase-project wordt gepauzeerd als het 7 dagen niet gebruikt is. Je krijgt dan eerst een waarschuwingsmail. Met een actieve groep gebeurt dit niet snel. Gebeurt het toch, open dan het project in Supabase en klik op **Resume project**. Alle gegevens zijn er dan nog.
- **De app bijwerken:** upload het gewijzigde bestand opnieuw op GitHub via **Add file → Upload files**. Een bestand met dezelfde naam wordt dan vervangen.
