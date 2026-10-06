import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createPrismaClient } from '@rm/db';
import { loadEnv } from '@rm/shared-utils';
import { createStorage } from '@rm/storage';

/**
 * Demo content for development and for the responsive check of Task 20:
 * the agency's own routes, taken from the posters it published on social
 * media (`assets/rutas/`). Names, dates, destinations and inclusions come
 * from those posters; each cover is the poster's central photo
 * (`prisma/demo/covers/`).
 *
 * **Prices, deposits and capacity are illustrative.** The posters do not
 * publish them; the numbers below exist only so the catalogue and the
 * reservation flow have something to show. Never run this against
 * production data -- it refuses to unless `ALLOW_DEMO_SEED=1` is set.
 *
 * Idempotent: a trip whose slug already exists is left alone.
 */

interface DemoTrip {
  slug: string;
  departure: string;
  return: string;
  /** Illustrative, in MXN cents. */
  priceCents: number;
  es: {
    name: string;
    description: string;
    itinerary: string;
    includes: string;
    excludes: string;
  };
  en: {
    name: string;
    description: string;
    itinerary: string;
    includes: string;
    excludes: string;
  };
}

const TRIPS: DemoTrip[] = [
  {
    slug: 'ruta-valquirico-2026',
    departure: '2026-10-18',
    return: '2026-10-18',
    priceCents: 129_000,
    es: {
      name: 'Ruta ValQuirico',
      description:
        'Villa Toscana, Cholula y el Santuario de los Remedios en un solo día.',
      itinerary:
        'Domingo 18 de octubre: Cholula, Santuario de los Remedios, zona arqueológica y la villa toscana de ValQuirico.',
      includes:
        'Traslado redondo en autobús de lujo · Seguro carretero · Visita al pueblo mágico de Cholula · Guías locales · Accesos incluidos · Mapa guía de recomendaciones',
      excludes: 'Alimentos no mencionados',
    },
    en: {
      name: 'ValQuirico Route',
      description:
        'Villa Toscana, Cholula and the Sanctuary of Los Remedios in a single day.',
      itinerary:
        'Sunday, October 18: Cholula, Sanctuary of Los Remedios, the archaeological site and the Tuscan-style village of ValQuirico.',
      includes:
        'Round-trip luxury coach · Road insurance · Visit to the magic town of Cholula · Local guides · Entrance fees · Recommendations map',
      excludes: 'Meals not listed',
    },
  },
  {
    slug: 'ruta-puerto-escondido-2026',
    departure: '2026-11-27',
    return: '2026-11-30',
    priceCents: 899_000,
    es: {
      name: 'Ruta Puerto Escondido',
      description:
        'Mazunte, Carrizalillo, Zipolite, Punta Cometa y liberación de tortugas.',
      itinerary:
        'Viernes a lunes: playas de Puerto Escondido, pueblo mágico de Mazunte, atardecer en Punta Cometa y liberación de tortugas.',
      includes:
        'Traslado redondo en autobús de lujo · Seguro carretero · Vuelos redondos a Puerto Escondido · Hospedaje en Zicatela con desayuno · Recorrido por las playas · Liberación de tortugas · Guías locales · Mapa guía de recomendaciones',
      excludes: 'Equipaje documentado',
    },
    en: {
      name: 'Puerto Escondido Route',
      description:
        'Mazunte, Carrizalillo, Zipolite, Punta Cometa and a turtle release.',
      itinerary:
        'Friday to Monday: Puerto Escondido beaches, the magic town of Mazunte, sunset at Punta Cometa and a turtle release.',
      includes:
        'Round-trip luxury coach · Road insurance · Round-trip flights to Puerto Escondido · Hotel in Zicatela with breakfast · Beach tour · Turtle release · Local guides · Recommendations map',
      excludes: 'Checked luggage',
    },
  },
  {
    slug: 'ruta-pinal-de-amoles-2026',
    departure: '2026-12-05',
    return: '2026-12-06',
    priceCents: 249_000,
    es: {
      name: 'Ruta Pinal de Amoles',
      description:
        'Mirador Cuatro Palos, Peña de Bernal y la cascada de El Chuveje.',
      itinerary:
        'Sábado y domingo: amanecer en el Mirador Cuatro Palos, cascada de El Chuveje y el pueblo mágico de Bernal.',
      includes:
        'Traslado redondo en autobús de lujo · Seguro carretero · Hospedaje en el pueblo mágico de Bernal · Pago de permisos federales · Entradas incluidas · Guías locales · Mapa guía de recomendaciones',
      excludes: 'Alimentos no mencionados',
    },
    en: {
      name: 'Pinal de Amoles Route',
      description:
        'Cuatro Palos viewpoint, Peña de Bernal and El Chuveje waterfall.',
      itinerary:
        'Saturday and Sunday: sunrise at the Cuatro Palos viewpoint, El Chuveje waterfall and the magic town of Bernal.',
      includes:
        'Round-trip luxury coach · Road insurance · Hotel in the magic town of Bernal · Federal permits · Entrance fees · Local guides · Recommendations map',
      excludes: 'Meals not listed',
    },
  },
  {
    slug: 'ruta-punta-monterrey-2026',
    departure: '2026-12-11',
    return: '2026-12-13',
    priceCents: 1_190_000,
    es: {
      name: 'Ruta Punta Monterrey',
      description:
        'Edición deluxe: una experiencia única en la Riviera Nayarit.',
      itinerary:
        'Viernes a domingo en el complejo Punta Monterrey, con playa privada y visitas a San Francisco y Punta de Mita.',
      includes:
        'Traslado redondo hasta la Riviera Nayarit · Seguro carretero · Hospedaje 5 estrellas con playa privada · Todas las comidas incluidas · Chef privado · Cena de agradecimiento de fin de año · Mapa guía de recomendaciones',
      excludes: 'Bebidas no mencionadas',
    },
    en: {
      name: 'Punta Monterrey Route',
      description:
        'Deluxe edition: a one-of-a-kind stay on the Riviera Nayarit.',
      itinerary:
        'Friday to Sunday at the Punta Monterrey resort, with a private beach and visits to San Francisco and Punta de Mita.',
      includes:
        'Round trip to the Riviera Nayarit · Road insurance · 5-star stay with a private beach · All meals · Private chef · Year-end thank-you dinner · Recommendations map',
      excludes: 'Drinks not listed',
    },
  },
  {
    slug: 'ruta-real-de-catorce-2027',
    departure: '2027-01-23',
    return: '2027-01-24',
    priceCents: 279_000,
    es: {
      name: 'Ruta Real de Catorce',
      description:
        'El Templo, el Túnel Ogarrio, recorrido en Willys y Estación Catorce.',
      itinerary:
        'Sábado y domingo: centro histórico, recorrido en Willys 4x4 a Estación Catorce, Túnel Ogarrio y recorrido nocturno de leyendas.',
      includes:
        'Traslado redondo en autobús de lujo · Seguro carretero · Hospedaje en el centro histórico · Recorrido en Willys 4x4 · Guías locales · Accesos incluidos · Mapa guía de recomendaciones',
      excludes: 'Alimentos no mencionados',
    },
    en: {
      name: 'Real de Catorce Route',
      description:
        'The Temple, the Ogarrio Tunnel, a Willys jeep ride and Estación Catorce.',
      itinerary:
        'Saturday and Sunday: the historic centre, a Willys 4x4 ride to Estación Catorce, the Ogarrio Tunnel and a night legends tour.',
      includes:
        'Round-trip luxury coach · Road insurance · Hotel in the historic centre · Willys 4x4 ride · Local guides · Entrance fees · Recommendations map',
      excludes: 'Meals not listed',
    },
  },
  {
    slug: 'ruta-colombia-2027',
    departure: '2027-04-01',
    return: '2027-04-07',
    priceCents: 3_290_000,
    es: {
      name: 'Ruta Colombia',
      description:
        'Tercera edición: Cartagena, Medellín, Guatapé, Bogotá, Comuna 13 e Islas del Rosario.',
      itinerary:
        'Jueves a miércoles por Cartagena, Medellín, Guatapé y Bogotá, con la Comuna 13 y las Islas del Rosario.',
      includes:
        'Traslado al aeropuerto internacional · Seguro carretero · Vuelo redondo · Hoteles 4 estrellas · Desayunos · Vuelos internos · Guía local · Piedra del Peñol · Recorrido en tuk tuk · City tour por la ciudad amurallada · Mapa guía de recomendaciones',
      excludes: 'Equipaje documentado',
    },
    en: {
      name: 'Colombia Route',
      description:
        'Third edition: Cartagena, Medellín, Guatapé, Bogotá, Comuna 13 and the Rosario Islands.',
      itinerary:
        'Thursday to Wednesday through Cartagena, Medellín, Guatapé and Bogotá, with Comuna 13 and the Rosario Islands.',
      includes:
        'Transfer to the international airport · Road insurance · Round-trip flight · 4-star hotels · Breakfasts · Domestic flights · Local guide · El Peñol rock · Tuk tuk tour · Walled city tour · Recommendations map',
      excludes: 'Checked luggage',
    },
  },
  {
    slug: 'ruta-brasil-2027',
    departure: '2027-11-10',
    return: '2027-11-17',
    priceCents: 4_490_000,
    es: {
      name: 'Ruta Brasil',
      description:
        'Segunda edición: Río de Janeiro, Copacabana, Cristo Redentor y Pan de Azúcar.',
      itinerary:
        'Miércoles a miércoles en Río de Janeiro: Cristo Redentor, Pan de Azúcar, Copacabana, Estadio Maracanã y Arraial do Cabo.',
      includes:
        'Traslado al aeropuerto en autobús de lujo · Seguro carretero · Hotel 4 estrellas en Copacabana · Vuelos redondos México–Brasil · Desayunos · Guías locales · Clase y show de samba · Mapa guía de recomendaciones',
      excludes: 'Equipaje documentado',
    },
    en: {
      name: 'Brazil Route',
      description:
        'Second edition: Rio de Janeiro, Copacabana, Christ the Redeemer and Sugarloaf Mountain.',
      itinerary:
        'Wednesday to Wednesday in Rio de Janeiro: Christ the Redeemer, Sugarloaf, Copacabana, the Maracanã stadium and Arraial do Cabo.',
      includes:
        'Luxury coach to the airport · Road insurance · 4-star hotel in Copacabana · Round-trip flights Mexico–Brazil · Breakfasts · Local guides · Samba class and show · Recommendations map',
      excludes: 'Checked luggage',
    },
  },
];

/** Illustrative: 20 seats, a fifth of the price as deposit, payments closing two weeks before departure. */
const DEMO_CAPACITY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const COVERS_DIR = join(__dirname, 'demo', 'covers');

async function main() {
  if (
    process.env['NODE_ENV'] === 'production' &&
    process.env['ALLOW_DEMO_SEED'] !== '1'
  ) {
    throw new Error(
      'Refusing to seed demo trips in production. Set ALLOW_DEMO_SEED=1 if you really mean it.',
    );
  }

  const env = loadEnv(process.env);
  const db = createPrismaClient(env.databaseUrl);
  // A relative STORAGE_LOCAL_ROOT is relative to the process that reads it,
  // and the API runs from apps/api (`nx dev api`), not from the repo root
  // this script runs from. Resolve it the way the API will, or the covers
  // land where nobody serves them.
  const storage = createStorage(
    env.storageLocalRoot && !isAbsolute(env.storageLocalRoot)
      ? {
          ...env,
          storageLocalRoot: resolve(
            __dirname,
            '../../../apps/api',
            env.storageLocalRoot,
          ),
        }
      : env,
  );

  try {
    const admin = await db.user.findFirst({
      where: { type: 'STAFF' },
      orderBy: { createdAt: 'asc' },
    });
    if (!admin)
      throw new Error('No staff user found. Run `pnpm db:seed` first.');

    let created = 0;
    for (const trip of TRIPS) {
      if (await db.trip.findUnique({ where: { slug: trip.slug } })) continue;

      const departure = new Date(`${trip.departure}T00:00:00.000Z`);
      const row = await db.trip.create({
        data: {
          slug: trip.slug,
          status: 'PUBLISHED',
          publishedAt: new Date(),
          departureDate: departure,
          returnDate: new Date(`${trip.return}T00:00:00.000Z`),
          paymentDeadline: new Date(departure.getTime() - 14 * DAY_MS),
          totalCapacity: DEMO_CAPACITY,
          holdTtlHours: 72,
          minimumDepositCents: Math.round(trip.priceCents / 5 / 100) * 100,
          pricePerSeatCents: trip.priceCents,
          priceMode: 'MANUAL',
          createdById: admin.id,
          translations: {
            create: [
              { locale: 'es', ...trip.es },
              { locale: 'en', ...trip.en },
            ],
          },
        },
      });

      const cover = trip.slug.replace(/^ruta-/, '').replace(/-\d{4}$/, '');
      const key = `trips/${row.id}/cover.jpg`;
      await storage.put(
        key,
        await readFile(join(COVERS_DIR, `${cover}.jpg`)),
        'image/jpeg',
      );
      await db.tripImage.create({
        data: {
          tripId: row.id,
          storageKey: key,
          position: 0,
          isCover: true,
          altText: trip.es.name,
        },
      });
      created += 1;
    }

    console.log(
      `Demo seed: ${created} trip(s) created, ${TRIPS.length - created} already present.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
