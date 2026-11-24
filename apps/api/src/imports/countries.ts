/**
 * Country cells of an import matched to the CRM's country list (the `country` lookup). A value is matched when it
 * equals a listed country ignoring case, accents and punctuation, or through an alias (ISO codes, short forms, local
 * spellings). An alias only ever leads to a country that is on the list: never to a country the CRM does not have.
 */

/** Lower case, accents removed, everything but letters and digits removed ("U.A.E." → "uae", "España" → "espana"). */
export function squashCountry(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * ISO-2 | ISO-3 | names (the first is the English name; the rest are other names, short forms and local spellings).
 * "NA" (Namibia) and "NO" (Norway) are left out as codes: "n/a" and "no" are what a blank cell often says.
 */
const TABLE = `
AF|AFG|Afghanistan|Afganistán
AL|ALB|Albania|Albanie
DZ|DZA|Algeria|Argelia|Algérie
AD|AND|Andorra|Andorre
AO|AGO|Angola
AG|ATG|Antigua and Barbuda
AR|ARG|Argentina|Argentine
AM|ARM|Armenia|Arménie
AU|AUS|Australia|Australie
AT|AUT|Austria|Österreich|Autriche
AZ|AZE|Azerbaijan|Azerbaiyán|Azerbaïdjan
BS|BHS|Bahamas|The Bahamas
BH|BHR|Bahrain|Baréin|Bahreïn
BD|BGD|Bangladesh
BB|BRB|Barbados
BY|BLR|Belarus|Bielorrusia|Biélorussie
BE|BEL|Belgium|Bélgica|Belgique|België
BZ|BLZ|Belize|Belice
BJ|BEN|Benin|Benín|Bénin
BT|BTN|Bhutan|Bután|Bhoutan
BO|BOL|Bolivia|Bolivie
BA|BIH|Bosnia and Herzegovina|Bosnia
BW|BWA|Botswana
BR|BRA|Brazil|Brasil|Brésil
BN|BRN|Brunei|Brunei Darussalam
BG|BGR|Bulgaria|Bulgarie
BF|BFA|Burkina Faso
BI|BDI|Burundi
CV|CPV|Cape Verde|Cabo Verde
KH|KHM|Cambodia|Camboya|Cambodge
CM|CMR|Cameroon|Camerún|Cameroun
CA|CAN|Canada|Canadá
CF|CAF|Central African Republic
TD|TCD|Chad|Tchad
CL|CHL|Chile|Chili
CN|CHN|China|Chine|PRC|People's Republic of China
CO|COL|Colombia|Colombie
KM|COM|Comoros
CG|COG|Congo|Republic of the Congo
CD|COD|Democratic Republic of the Congo|DR Congo|DRC
CR|CRI|Costa Rica
CI|CIV|Côte d'Ivoire|Ivory Coast|Costa de Marfil
HR|HRV|Croatia|Croacia|Croatie|Hrvatska
CU|CUB|Cuba
CY|CYP|Cyprus|Chipre|Chypre
CZ|CZE|Czechia|Czech Republic|República Checa|Tchéquie
DK|DNK|Denmark|Dinamarca|Danemark|Danmark
DJ|DJI|Djibouti|Yibuti
DM|DMA|Dominica
DO|DOM|Dominican Republic|República Dominicana|République dominicaine
EC|ECU|Ecuador|Équateur
EG|EGY|Egypt|Egipto|Égypte
SV|SLV|El Salvador|Salvador
GQ|GNQ|Equatorial Guinea|Guinea Ecuatorial
ER|ERI|Eritrea|Érythrée
EE|EST|Estonia|Estonie
SZ|SWZ|Eswatini|Swaziland
ET|ETH|Ethiopia|Etiopía|Éthiopie
FJ|FJI|Fiji|Fiyi|Fidji
FI|FIN|Finland|Finlandia|Finlande|Suomi
FR|FRA|France|Francia
GA|GAB|Gabon|Gabón
GM|GMB|Gambia|The Gambia|Gambie
GE|GEO|Georgia|Géorgie
DE|DEU|Germany|Deutschland|Alemania|Allemagne
GH|GHA|Ghana
GR|GRC|Greece|Grecia|Grèce|Hellas
GD|GRD|Grenada|Granada
GT|GTM|Guatemala
GN|GIN|Guinea|Guinée
GW|GNB|Guinea-Bissau
GY|GUY|Guyana
HT|HTI|Haiti|Haití|Haïti
HN|HND|Honduras
HK|HKG|Hong Kong
HU|HUN|Hungary|Hungría|Hongrie|Magyarország
IS|ISL|Iceland|Islandia|Islande
IN|IND|India|Inde|Bharat
ID|IDN|Indonesia|Indonésie
IR|IRN|Iran|Irán
IQ|IRQ|Iraq|Irak
IE|IRL|Ireland|Irlanda|Irlande|Republic of Ireland|Eire
IL|ISR|Israel|Israël
IT|ITA|Italy|Italia|Italie
JM|JAM|Jamaica|Jamaïque
JP|JPN|Japan|Japón|Japon
JO|JOR|Jordan|Jordania|Jordanie
KZ|KAZ|Kazakhstan|Kazajistán
KE|KEN|Kenya|Kenia
KI|KIR|Kiribati
KP|PRK|North Korea|Corea del Norte|Corée du Nord
KR|KOR|South Korea|Korea|Republic of Korea|Korea, Republic of|Corea del Sur|Corée du Sud
KW|KWT|Kuwait|Koweït
KG|KGZ|Kyrgyzstan|Kirguistán|Kirghizistan
LA|LAO|Laos
LV|LVA|Latvia|Letonia|Lettonie
LB|LBN|Lebanon|Líbano|Liban
LS|LSO|Lesotho
LR|LBR|Liberia|Libéria
LY|LBY|Libya|Libia|Libye
LI|LIE|Liechtenstein
LT|LTU|Lithuania|Lituania|Lituanie
LU|LUX|Luxembourg|Luxemburgo
MO|MAC|Macao|Macau
MG|MDG|Madagascar
MW|MWI|Malawi
MY|MYS|Malaysia|Malasia|Malaisie
MV|MDV|Maldives|Maldivas
ML|MLI|Mali|Malí
MT|MLT|Malta|Malte
MH|MHL|Marshall Islands
MR|MRT|Mauritania|Mauritanie
MU|MUS|Mauritius|Mauricio|Maurice
MX|MEX|Mexico|México|Mexique
FM|FSM|Micronesia
MD|MDA|Moldova|Moldavia|Moldavie
MC|MCO|Monaco|Mónaco
MN|MNG|Mongolia|Mongolie
ME|MNE|Montenegro|Monténégro
MA|MAR|Morocco|Marruecos|Maroc
MZ|MOZ|Mozambique
MM|MMR|Myanmar|Burma|Birmanie
|NAM|Namibia|Namibie
NR|NRU|Nauru
NP|NPL|Nepal|Népal
NL|NLD|Netherlands|The Netherlands|Holland|Países Bajos|Holanda|Pays-Bas|Nederland
NZ|NZL|New Zealand|Nueva Zelanda|Nouvelle-Zélande
NI|NIC|Nicaragua
NE|NER|Niger|Níger
NG|NGA|Nigeria|Nigéria
MK|MKD|North Macedonia|Macedonia
|NOR|Norway|Noruega|Norvège|Norge
OM|OMN|Oman|Omán
PK|PAK|Pakistan|Pakistán
PW|PLW|Palau
PS|PSE|Palestine|Palestina
PA|PAN|Panama|Panamá
PG|PNG|Papua New Guinea
PY|PRY|Paraguay
PE|PER|Peru|Perú|Pérou
PH|PHL|Philippines|Filipinas
PL|POL|Poland|Polonia|Pologne|Polska
PT|PRT|Portugal
PR|PRI|Puerto Rico|Porto Rico
QA|QAT|Qatar|Catar
RO|ROU|Romania|Rumania|Roumanie
RU|RUS|Russia|Russian Federation|Rusia|Russie
RW|RWA|Rwanda|Ruanda
KN|KNA|Saint Kitts and Nevis
LC|LCA|Saint Lucia|Santa Lucía
VC|VCT|Saint Vincent and the Grenadines
WS|WSM|Samoa
SM|SMR|San Marino|Saint-Marin
ST|STP|Sao Tome and Principe|São Tomé and Príncipe
SA|SAU|Saudi Arabia|KSA|Kingdom of Saudi Arabia|Arabia Saudita|Arabie saoudite
SN|SEN|Senegal|Sénégal
RS|SRB|Serbia|Serbie
SC|SYC|Seychelles
SL|SLE|Sierra Leone|Sierra Leona
SG|SGP|Singapore|Singapur|Singapour
SK|SVK|Slovakia|Eslovaquia|Slovaquie
SI|SVN|Slovenia|Eslovenia|Slovénie
SB|SLB|Solomon Islands
SO|SOM|Somalia|Somalie
ZA|ZAF|South Africa|RSA|Sudáfrica|Afrique du Sud
SS|SSD|South Sudan
ES|ESP|Spain|España|Espagne
LK|LKA|Sri Lanka
SD|SDN|Sudan|Sudán|Soudan
SR|SUR|Suriname|Surinam
SE|SWE|Sweden|Suecia|Suède|Sverige
CH|CHE|Switzerland|Suiza|Suisse|Schweiz
SY|SYR|Syria|Siria|Syrie
TW|TWN|Taiwan|Taiwán
TJ|TJK|Tajikistan|Tayikistán
TZ|TZA|Tanzania|Tanzanie
TH|THA|Thailand|Tailandia|Thaïlande
TL|TLS|Timor-Leste|East Timor
TG|TGO|Togo
TO|TON|Tonga
TT|TTO|Trinidad and Tobago
TN|TUN|Tunisia|Túnez|Tunisie
TR|TUR|Turkey|Türkiye|Turquía|Turquie
TM|TKM|Turkmenistan
TV|TUV|Tuvalu
UG|UGA|Uganda|Ouganda
UA|UKR|Ukraine|Ucrania
AE|ARE|United Arab Emirates|UAE|U.A.E.|Emirates|Emiratos Árabes Unidos|Émirats arabes unis
GB|GBR|United Kingdom|UK|U.K.|Great Britain|Britain|England|Scotland|Wales|Northern Ireland|Reino Unido|Royaume-Uni
US|USA|United States|U.S.|U.S.A.|United States of America|America|Estados Unidos|EE. UU.|EEUU|États-Unis
UY|URY|Uruguay
UZ|UZB|Uzbekistan|Uzbekistán|Ouzbékistan
VU|VUT|Vanuatu
VA|VAT|Vatican City|Holy See
VE|VEN|Venezuela
VN|VNM|Vietnam|Viet Nam
YE|YEM|Yemen|Yémen
ZM|ZMB|Zambia|Zambie
ZW|ZWE|Zimbabwe
`;

/** Each squashed alias (codes and every name) → that country's names; a known value matching any name is returned. */
export const COUNTRY_ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const line of TABLE.split('\n')) {
    if (!line.trim()) continue;
    const [iso2, iso3, ...names] = line.split('|');
    for (const alias of [iso2!, iso3!, ...names]) {
      const key = squashCountry(alias);
      if (key && !map.has(key)) map.set(key, names);
    }
  }
  return map;
})();

/** The known list by squashed value, built once per list (a staging run passes the same array for every cell). */
const keyed = new WeakMap<readonly string[], Map<string, string>>();
function knownByKey(known: readonly string[]): Map<string, string> {
  let byKey = keyed.get(known);
  if (!byKey) {
    byKey = new Map();
    for (const k of known) {
      const s = squashCountry(k);
      if (s && !byKey.has(s)) byKey.set(s, k);
    }
    keyed.set(known, byKey);
  }
  return byKey;
}

/**
 * The CRM country `raw` stands for: a value of `known` equal to it (ignoring case, accents and punctuation), else
 * the value of `known` its alias leads to; null when neither (an unknown country).
 */
export function matchCountry(raw: string, known: readonly string[]): string | null {
  const key = squashCountry(raw);
  if (!key) return null;
  const byKey = knownByKey(known);
  const direct = byKey.get(key);
  if (direct) return direct;
  const names = COUNTRY_ALIASES.get(key);
  if (!names) return null;
  for (const name of names) {
    const hit = byKey.get(squashCountry(name));
    if (hit) return hit;
  }
  return null;
}
