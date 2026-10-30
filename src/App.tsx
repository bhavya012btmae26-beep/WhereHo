import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type { User } from '@supabase/supabase-js'
import MapView from './components/MapView'
import { supabase } from './supabaseClient'

type RouteOption = {
  coordinates: [number, number][]
  distance: number
  duration: number
  label: string
  icon: string
  recommendationScore: number
  safetyScore: number | null
  routeId: string
}

type RawRoute = {
  coordinates: [number, number][]
  distance: number
  duration: number
}

type SafetyData = {
  city: string
  year: number
  women_crime_rate: number
  data_confidence:
    | 'high'
    | 'medium'
    | 'low'
    | null
  source: string | null
}

type GeocodedLocation = {
  coordinates: [number, number]
  city: string
  displayName: string
}

type RouteCheckpoint = {
  route_id: string
  checkpoint_order: number
  latitude: number
  longitude: number
  area: string | null
  city: string | null

  area_safety_score: number | null
  area_safety_confidence:
    | 'high'
    | 'medium'
    | 'low'
    | null
  area_safety_source: string | null

  city_women_crime_rate: number | null
  city_data_year: number | null
  city_data_confidence:
    | 'high'
    | 'medium'
    | 'low'
    | null
  city_data_source: string | null
}

type AreaSafetyRecord = {
  city: string
  area: string
  latitude: number
  longitude: number
  safety_score: number | null
  data_confidence:
    | 'high'
    | 'medium'
    | 'low'
    | null
  source: string | null
}

type TrustedContact = {
  id?: number
  name: string
  phone_number: string
  email: string
  relationship: string
  is_primary: boolean
}

/*
 * ROUTE DEVIATION SETTINGS
 */

const ROUTE_DEVIATION_THRESHOLD_METERS = 75
const ROUTE_DEVIATION_CONFIRMATIONS = 2
const REROUTE_COOLDOWN_MS = 15000

/*
 * ROUTE SAFETY WEIGHTS
 */

const SAFETY_WEIGHT = 0.65
const TIME_WEIGHT = 0.35

/*
 * CITY NORMALIZATION
 */

const normalizeCityName = (
  city: string | null | undefined
): string => {
  if (!city) return ''

  return city
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(
      /\b(city|district)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
}

const CITY_ALIASES: Record<string, string[]> = {
  delhi: [
    'delhi',
    'new delhi',
    'delhi city',
    'nct of delhi',
  ],

  'new delhi': [
    'delhi',
    'new delhi',
    'delhi city',
    'nct of delhi',
  ],

  'delhi city': [
    'delhi',
    'new delhi',
    'delhi city',
    'nct of delhi',
  ],

  noida: [
    'noida',
    'gautam buddha nagar',
    'gautam budh nagar',
    'gb nagar',
  ],

  'greater noida': [
    'greater noida',
    'noida',
    'gautam buddha nagar',
    'gautam budh nagar',
    'gb nagar',
  ],

  'gautam buddha nagar': [
    'gautam buddha nagar',
    'gautam budh nagar',
    'gb nagar',
    'noida',
    'greater noida',
  ],

  'gautam budh nagar': [
    'gautam buddha nagar',
    'gautam budh nagar',
    'gb nagar',
    'noida',
    'greater noida',
  ],

  'gb nagar': [
    'gautam buddha nagar',
    'gautam budh nagar',
    'gb nagar',
    'noida',
    'greater noida',
  ],

  gurgaon: [
    'gurgaon',
    'gurugram',
  ],

  gurugram: [
    'gurgaon',
    'gurugram',
  ],
}

const cityNamesMatch = (
  first: string | null | undefined,
  second: string | null | undefined
): boolean => {
  const firstNormalized =
    normalizeCityName(first)

  const secondNormalized =
    normalizeCityName(second)

  if (
    !firstNormalized ||
    !secondNormalized
  ) {
    return false
  }

  if (
    firstNormalized ===
    secondNormalized
  ) {
    return true
  }

  const firstAliases =
    CITY_ALIASES[firstNormalized] ??
    [firstNormalized]

  const secondAliases =
    CITY_ALIASES[secondNormalized] ??
    [secondNormalized]

  return (
    firstAliases.some(
      (alias) =>
        normalizeCityName(alias) ===
        secondNormalized
    ) ||
    secondAliases.some(
      (alias) =>
        normalizeCityName(alias) ===
        firstNormalized
    ) ||
    firstAliases.some(
      (alias) =>
        secondAliases.includes(alias)
    )
  )
}

/*
 * GET REAL ROUTES
 */

const getRealRoutes = async (
  start: [number, number],
  destination: [number, number]
): Promise<RawRoute[]> => {
  const [startLat, startLon] = start

  const [
    destinationLat,
    destinationLon,
  ] = destination

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${startLon},${startLat};${destinationLon},${destinationLat}` +
    '?overview=full&geometries=geojson&alternatives=true&steps=false'

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      'Could not retrieve routes. Please try again.'
    )
  }

  const data = await response.json()

  if (
    data.code !== 'Ok' ||
    !data.routes?.length
  ) {
    throw new Error(
      'No driving routes found for these locations.'
    )
  }

  return data.routes.map(
    (route: {
      geometry: {
        coordinates: [number, number][]
      }
      distance: number
      duration: number
    }): RawRoute => ({
      coordinates:
        route.geometry.coordinates.map(
          ([longitude, latitude]) =>
            [
              latitude,
              longitude,
            ] as [number, number]
        ),
      distance: route.distance,
      duration: route.duration,
    })
  )
}

/*
 * GEOCODE LOCATION
 */

const geocodeLocation = async (
  query: string
): Promise<GeocodedLocation> => {
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'in',
    q: query,
  })

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`
  )

  if (!response.ok) {
    throw new Error(
      `Could not find "${query}". Please try again.`
    )
  }

  const results =
    await response.json()

  if (!results.length) {
    throw new Error(
      `Location "${query}" was not found. Try adding the city name.`
    )
  }

  const result = results[0]
  const address = result.address ?? {}

  const city =
    address.city ??
    address.town ??
    address.municipality ??
    address.city_district ??
    address.county ??
    address.state_district ??
    address.state ??
    ''

  return {
    coordinates: [
      Number(result.lat),
      Number(result.lon),
    ],
    city,
    displayName:
      result.display_name,
  }
}

/*
 * CITY CRIME RATE -> DERIVED SCORE
 */

const calculateSafetyScore = (
  womenCrimeRate: number
): number => {
  const highestRate = 266.3
  const lowestRate = 17.3

  const score =
    100 -
    ((womenCrimeRate -
      lowestRate) /
      (highestRate -
        lowestRate)) *
      100

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  )
}

/*
 * GENERATE CHECKPOINTS
 */

const generateCheckpoints = (
  coordinates: [number, number][],
  routeId: string
): RouteCheckpoint[] => {
  if (!coordinates.length) {
    return []
  }

  const count = Math.min(
    5,
    coordinates.length
  )

  return Array.from(
    { length: count },
    (_, i) => {
      const index =
        count === 1
          ? 0
          : Math.round(
              (i *
                (coordinates.length -
                  1)) /
                (count - 1)
            )

      const [
        latitude,
        longitude,
      ] = coordinates[index]

      return {
        route_id: routeId,
        checkpoint_order: i + 1,
        latitude,
        longitude,
        area: null,
        city: null,

        area_safety_score:
          null,
        area_safety_confidence:
          null,
        area_safety_source:
          null,

        city_women_crime_rate:
          null,
        city_data_year: null,
        city_data_confidence:
          null,
        city_data_source:
          null,
      }
    }
  )
}

/*
 * REVERSE GEOCODE CHECKPOINT
 */

const reverseGeocodeCheckpoint =
  async (
    checkpoint: RouteCheckpoint
  ): Promise<RouteCheckpoint> => {
    try {
      const params =
        new URLSearchParams({
          format: 'jsonv2',
          lat: String(
            checkpoint.latitude
          ),
          lon: String(
            checkpoint.longitude
          ),
          zoom: '16',
          addressdetails: '1',
        })

      const response =
        await fetch(
          `https://nominatim.openstreetmap.org/reverse?${params.toString()}`
        )

      if (!response.ok) {
        return checkpoint
      }

      const result =
        await response.json()

      const address =
        result.address ?? {}

      const area =
        address.neighbourhood ??
        address.suburb ??
        address.quarter ??
        address.residential ??
        address.hamlet ??
        address.village ??
        null

      const city =
        address.city ??
        address.town ??
        address.municipality ??
        address.city_district ??
        address.county ??
        address.state_district ??
        null

      return {
        ...checkpoint,
        area,
        city,
      }
    } catch (err) {
      console.warn(
        'Checkpoint locality lookup failed:',
        err
      )

      return checkpoint
    }
  }

/*
 * ENRICH CHECKPOINT LOCALITIES
 */

const enrichCheckpoints =
  async (
    points: RouteCheckpoint[]
  ): Promise<RouteCheckpoint[]> => {
    const enriched:
      RouteCheckpoint[] = []

    for (
      let i = 0;
      i < points.length;
      i++
    ) {
      if (i > 0) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              1100
            )
        )
      }

      enriched.push(
        await reverseGeocodeCheckpoint(
          points[i]
        )
      )
    }

    return enriched
  }

/*
 * DISTANCE CALCULATION
 */

const distanceInMeters = (
  a: [number, number],
  b: [number, number]
): number => {
  const radians = (
    degrees: number
  ) =>
    (degrees * Math.PI) / 180

  const earthRadius = 6371000

  const latitudeDifference =
    radians(b[0] - a[0])

  const longitudeDifference =
    radians(b[1] - a[1])

  const latitudeA =
    radians(a[0])

  const latitudeB =
    radians(b[0])

  const value =
    Math.sin(
      latitudeDifference / 2
    ) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(
        longitudeDifference / 2
      ) ** 2

  return (
    2 *
    earthRadius *
    Math.atan2(
      Math.sqrt(value),
      Math.sqrt(1 - value)
    )
  )
}

/*
 * FIND CLOSEST ROUTE POINT
 */

const getNearestRoutePoint = (
  userLocation: [number, number],
  coordinates: [number, number][]
): {
  index: number
  distanceFromRoute: number
} => {
  let nearestIndex = 0
  let nearestDistance = Infinity

  coordinates.forEach(
    (
      coordinate,
      index
    ) => {
      const distance =
        distanceInMeters(
          userLocation,
          coordinate
        )

      if (
        distance <
        nearestDistance
      ) {
        nearestDistance =
          distance

        nearestIndex =
          index
      }
    }
  )

  return {
    index: nearestIndex,
    distanceFromRoute:
      nearestDistance,
  }
}

/*
 * REMAINING ROUTE DISTANCE
 */

const getRemainingRouteDistance =
  (
    userLocation: [number, number],
    coordinates: [number, number][]
  ): number => {
    if (
      coordinates.length < 2
    ) {
      return 0
    }

    const {
      index,
      distanceFromRoute,
    } =
      getNearestRoutePoint(
        userLocation,
        coordinates
      )

    let remainingDistance =
      distanceFromRoute

    for (
      let i = index;
      i <
      coordinates.length - 1;
      i++
    ) {
      remainingDistance +=
        distanceInMeters(
          coordinates[i],
          coordinates[i + 1]
        )
    }

    return remainingDistance
  }

/*
 * AREA SAFETY LOOKUP
 */

const lookupCheckpointSafety =
  async (
    checkpoint: RouteCheckpoint
  ): Promise<RouteCheckpoint> => {
    try {
      const {
        data,
        error,
      } =
        await supabase
          .from(
            'area_safety_data'
          )
          .select(
            'city, area, latitude, longitude, safety_score, data_confidence, source'
          )

      if (error) {
        console.warn(
          'Area safety lookup failed:',
          error.message
        )

        return checkpoint
      }

      const records =
        (data ??
          []) as AreaSafetyRecord[]

      const nearbyRecords =
        records
          .filter(
            (record) => {
              const score =
                Number(
                  record.safety_score
                )

              if (
                !record.source?.trim() ||
                record.safety_score ===
                  null ||
                !Number.isFinite(
                  score
                ) ||
                score < 0 ||
                score > 100
              ) {
                return false
              }

              if (
                checkpoint.city &&
                record.city &&
                !cityNamesMatch(
                  checkpoint.city,
                  record.city
                )
              ) {
                return false
              }

              const distance =
                distanceInMeters(
                  [
                    checkpoint.latitude,
                    checkpoint.longitude,
                  ],
                  [
                    Number(
                      record.latitude
                    ),
                    Number(
                      record.longitude
                    ),
                  ]
                )

              return (
                distance <=
                2000
              )
            }
          )
          .sort(
            (a, b) =>
              distanceInMeters(
                [
                  checkpoint.latitude,
                  checkpoint.longitude,
                ],
                [
                  Number(
                    a.latitude
                  ),
                  Number(
                    a.longitude
                  ),
                ]
              ) -
              distanceInMeters(
                [
                  checkpoint.latitude,
                  checkpoint.longitude,
                ],
                [
                  Number(
                    b.latitude
                  ),
                  Number(
                    b.longitude
                  ),
                ]
              )
          )

      const match =
        nearbyRecords[0]

      if (!match) {
        return checkpoint
      }

      return {
        ...checkpoint,
        area_safety_score:
          Number(
            match.safety_score
          ),
        area_safety_confidence:
          match.data_confidence,
        area_safety_source:
          match.source,
      }
    } catch (err) {
      console.warn(
        'Area safety lookup failed:',
        err
      )

      return checkpoint
    }
  }

/*
 * CITY CRIME LOOKUP
 */

const lookupCityCrimeContext =
  async (
    city: string | null
  ): Promise<{
    city_women_crime_rate: number
    city_data_year: number
    city_data_confidence:
      | 'high'
      | 'medium'
      | 'low'
      | null
    city_data_source:
      | string
      | null
  } | null> => {
    if (!city?.trim()) {
      return null
    }

    try {
      const {
        data,
        error,
      } =
        await supabase
          .from('safety_data')
          .select(
            'city, year, women_crime_rate, data_confidence, source'
          )
          .order(
            'year',
            {
              ascending:
                false,
            }
          )
          .limit(500)

      if (error) {
        console.warn(
          'City crime context lookup failed:',
          error.message
        )

        return null
      }

      const records =
        (data ??
          []) as SafetyData[]

      const matchingRecords =
        records.filter(
          (record) =>
            cityNamesMatch(
              city,
              record.city
            )
        )

      if (
        !matchingRecords.length
      ) {
        return null
      }

      const matchingRecord =
        matchingRecords.find(
          (record) => {
            const rate =
              Number(
                record.women_crime_rate
              )

            return (
              Number.isFinite(
                rate
              ) &&
              rate >= 0
            )
          }
        )

      if (!matchingRecord) {
        return null
      }

      return {
        city_women_crime_rate:
          Number(
            matchingRecord.women_crime_rate
          ),
        city_data_year:
          Number(
            matchingRecord.year
          ),
        city_data_confidence:
          matchingRecord.data_confidence,
        city_data_source:
          matchingRecord.source,
      }
    } catch (err) {
      console.warn(
        'City crime context lookup failed:',
        err
      )

      return null
    }
  }

/*
 * ENRICH CHECKPOINT SAFETY
 */

const enrichCheckpointSafety =
  async (
    checkpoints: RouteCheckpoint[]
  ): Promise<RouteCheckpoint[]> => {
    const results:
      RouteCheckpoint[] = []

    for (
      const checkpoint of
      checkpoints
    ) {
      const areaEnriched =
        await lookupCheckpointSafety(
          checkpoint
        )

      if (
        areaEnriched.area_safety_score !==
        null
      ) {
        results.push(
          areaEnriched
        )

        continue
      }

      const cityContext =
        await lookupCityCrimeContext(
          areaEnriched.city
        )

      results.push({
        ...areaEnriched,
        ...(cityContext ?? {
          city_women_crime_rate:
            null,
          city_data_year:
            null,
          city_data_confidence:
            null,
          city_data_source:
            null,
        }),
      })
    }

    return results
  }

/*
 * CALCULATE ROUTE SAFETY SCORE
 */

const calculateRouteSafetyScore = (
  checkpoints: RouteCheckpoint[]
): number | null => {
  const usableScores =
    checkpoints
      .map(
        (checkpoint) => {
          if (
            checkpoint.area_safety_score !==
              null &&
            Number.isFinite(
              checkpoint.area_safety_score
            )
          ) {
            const confidenceWeight =
              checkpoint.area_safety_confidence ===
              'high'
                ? 1
                : checkpoint.area_safety_confidence ===
                    'medium'
                  ? 0.75
                  : checkpoint.area_safety_confidence ===
                      'low'
                    ? 0.5
                    : 0.35

            return {
              score:
                checkpoint.area_safety_score,
              weight:
                confidenceWeight,
            }
          }

          if (
            checkpoint.city_women_crime_rate !==
              null &&
            Number.isFinite(
              checkpoint.city_women_crime_rate
            )
          ) {
            const cityScore =
              calculateSafetyScore(
                checkpoint.city_women_crime_rate
              )

            const confidenceWeight =
              checkpoint.city_data_confidence ===
              'high'
                ? 1
                : checkpoint.city_data_confidence ===
                    'medium'
                  ? 0.75
                  : checkpoint.city_data_confidence ===
                      'low'
                    ? 0.5
                    : 0.35

            return {
              score:
                cityScore,
              weight:
                confidenceWeight,
            }
          }

          return null
        }
      )
      .filter(
        (
          value
        ): value is {
          score: number
          weight: number
        } =>
          value !== null
      )

  if (
    !usableScores.length
  ) {
    return null
  }

  const totalWeight =
    usableScores.reduce(
      (sum, item) =>
        sum + item.weight,
      0
    )

  if (
    totalWeight <= 0
  ) {
    return null
  }

  const weightedScore =
    usableScores.reduce(
      (sum, item) =>
        sum +
        item.score *
          item.weight,
      0
    ) / totalWeight

  return Math.round(
    Math.max(
      0,
      Math.min(
        100,
        weightedScore
      )
    )
  )
}

/*
 * BUILD AND SCORE ROUTES
 */

const buildScoredRoutes =
  async (
    rawRoutes: RawRoute[],
    routeIdPrefix: string
  ): Promise<{
    routes: RouteOption[]
    checkpointsByRoute:
      RouteCheckpoint[][]
    balancedIndex: number
    fastestIndex: number
  }> => {
    const fastestDuration =
      Math.min(
        ...rawRoutes.map(
          (route) =>
            route.duration
        )
      )

    const routeSafetyResults:
      Array<{
        checkpoints:
          RouteCheckpoint[]
        safetyScore:
          number | null
      }> = []

    for (
      let index = 0;
      index <
      rawRoutes.length;
      index++
    ) {
      const route =
        rawRoutes[index]

      const routeId =
        `${routeIdPrefix}-${index}`

      const basicCheckpoints =
        generateCheckpoints(
          route.coordinates,
          routeId
        )

      const localisedCheckpoints =
        await enrichCheckpoints(
          basicCheckpoints
        )

      const enrichedCheckpoints =
        await enrichCheckpointSafety(
          localisedCheckpoints
        )

      const routeSafetyScore =
        calculateRouteSafetyScore(
          enrichedCheckpoints
        )

      routeSafetyResults.push({
        checkpoints:
          enrichedCheckpoints,
        safetyScore:
          routeSafetyScore,
      })
    }

    const scoredRoutes =
      rawRoutes.map(
        (route, index) => {
          const timeScore =
            fastestDuration > 0
              ? (fastestDuration /
                  route.duration) *
                100
              : 100

          const safetyScore =
            routeSafetyResults[
              index
            ]?.safetyScore ??
            null

          const recommendationScore =
            safetyScore !== null
              ? Math.round(
                  safetyScore *
                    SAFETY_WEIGHT +
                    timeScore *
                      TIME_WEIGHT
                )
              : Math.round(
                  timeScore
                )

          return {
            ...route,
            routeId:
              `${routeIdPrefix}-${index}`,
            label:
              'Alternative',
            icon: '🛣️',
            recommendationScore,
            safetyScore,
          }
        }
      )

    const fastestIndex =
      scoredRoutes.reduce(
        (
          bestIndex,
          route,
          index,
          all
        ) =>
          route.duration <
          all[
            bestIndex
          ].duration
            ? index
            : bestIndex,
        0
      )

    const balancedIndex =
      scoredRoutes.reduce(
        (
          bestIndex,
          route,
          index,
          all
        ) =>
          route.recommendationScore >
          all[
            bestIndex
          ]
            .recommendationScore
            ? index
            : bestIndex,
        0
      )

    const labelledRoutes =
      scoredRoutes.map(
        (route, index) => {
          if (
            index ===
            balancedIndex
          ) {
            return {
              ...route,
              label:
                'Recommended',
              icon: '⭐',
            }
          }

          if (
            index ===
            fastestIndex
          ) {
            return {
              ...route,
              label:
                'Fastest',
              icon: '⚡',
            }
          }

          return route
        }
      )

    return {
      routes:
        labelledRoutes,
      checkpointsByRoute:
        routeSafetyResults.map(
          (result) =>
            result.checkpoints
        ),
      balancedIndex,
      fastestIndex,
    }
  }

/*
 * FORMAT DISTANCE
 */

const formatDistance = (
  meters: number
): string => {
  if (meters < 1000) {
    return `${Math.round(
      meters
    )} m`
  }

  return `${(
    meters / 1000
  ).toFixed(1)} km`
}

/*
 * FORMAT DURATION
 */

const formatDuration = (
  seconds: number
): string => {
  const minutes = Math.round(
    seconds / 60
  )

  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours =
    Math.floor(
      minutes / 60
    )

  const remainingMinutes =
    minutes % 60

  return remainingMinutes
    ? `${hours} hr ${remainingMinutes} min`
    : `${hours} hr`
}

function App() {
  const [user, setUser] =
    useState<User | null>(
      null
    )

  const [origin, setOrigin] =
    useState('')

  const [
    destinationText,
    setDestinationText,
  ] = useState('')

  const [start, setStart] =
    useState<
      [number, number] | null
    >(null)

  const [
    destination,
    setDestination,
  ] = useState<
    [number, number] | null
  >(null)

  const [routes, setRoutes] =
    useState<RouteOption[]>(
      []
    )

  const [
    selectedRoute,
    setSelectedRoute,
  ] = useState<number | null>(
    null
  )

  const [
    checkpoints,
    setCheckpoints,
  ] = useState<RouteCheckpoint[]>(
    []
  )

  const [
    safetyData,
    setSafetyData,
  ] = useState<SafetyData | null>(
    null
  )

  const [
    destinationCity,
    setDestinationCity,
  ] = useState('')

  const [loading, setLoading] =
    useState(false)

  const [
    authLoading,
    setAuthLoading,
  ] = useState(false)

  const [error, setError] =
    useState('')

  const [notice, setNotice] =
    useState('')

  const [
    trustedContact,
    setTrustedContact,
  ] = useState<TrustedContact>({
    name: '',
    phone_number: '',
    email: '',
    relationship: '',
    is_primary: true,
  })

  const [
    trustedContactLoading,
    setTrustedContactLoading,
  ] = useState(false)

  const [
    trustedContactMessage,
    setTrustedContactMessage,
  ] = useState('')

  const [
    journeyActive,
    setJourneyActive,
  ] = useState(false)

  const [
    userLocation,
    setUserLocation,
  ] = useState<
    [number, number] | null
  >(null)

  const [
    remainingDistance,
    setRemainingDistance,
  ] = useState<number | null>(
    null
  )

  const [
    remainingEta,
    setRemainingEta,
  ] = useState<number | null>(
    null
  )

  const [
    gpsStatus,
    setGpsStatus,
  ] = useState('')

  const watchIdRef =
    useRef<number | null>(
      null
    )

  const arrivalDetectedRef =
    useRef(false)

  const deviationCountRef =
    useRef(0)

  const lastRerouteTimeRef =
    useRef(0)

  const reroutingRef =
    useRef(false)

  const [
    sosLoading,
    setSosLoading,
  ] = useState(false)

  const [
    sosMessage,
    setSosMessage,
  ] = useState('')

  const selectionRequestRef =
    useRef(0)

  /*
   * AUTH SESSION
   */

  useEffect(() => {
    let mounted = true

    const loadSession =
      async () => {
        const {
          data,
          error:
            sessionError,
        } =
          await supabase.auth.getSession()

        if (!mounted) {
          return
        }

        if (sessionError) {
          console.error(
            'Could not load session:',
            sessionError.message
          )
        }

        setUser(
          data.session?.user ??
            null
        )
      }

    void loadSession()

    const {
      data: {
        subscription,
      },
    } =
      supabase.auth.onAuthStateChange(
        (
          _event,
          session
        ) => {
          if (mounted) {
            setUser(
              session?.user ??
                null
            )
          }
        }
      )

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  /*
   * LOAD TRUSTED CONTACT
   */

  useEffect(() => {
    let cancelled = false

    const loadTrustedContact =
      async () => {
        if (!user) {
          setTrustedContact({
            name: '',
            phone_number:
              '',
            email: '',
            relationship:
              '',
            is_primary: true,
          })

          setTrustedContactMessage(
            ''
          )

          return
        }

        setTrustedContactLoading(
          true
        )

        setTrustedContactMessage(
          ''
        )

        try {
          const {
            data,
            error,
          } =
            await supabase
              .from(
                'trusted_contacts'
              )
              .select(
                'id, name, phone_number, email, relationship, is_primary'
              )
              .eq(
                'user_id',
                user.id
              )
              .order(
                'is_primary',
                {
                  ascending:
                    false,
                }
              )
              .order(
                'created_at',
                {
                  ascending:
                    false,
                }
              )
              .limit(1)
              .maybeSingle()

          if (cancelled) {
            return
          }

          if (error) {
            console.error(
              'Could not load trusted contact:',
              error.message
            )

            setTrustedContactMessage(
              'Could not load your saved trusted contact.'
            )

            return
          }

          if (data) {
            setTrustedContact({
              id: data.id,
              name:
                data.name ??
                '',
              phone_number:
                data.phone_number ??
                '',
              email:
                data.email ??
                '',
              relationship:
                data.relationship ??
                '',
              is_primary:
                data.is_primary ??
                true,
            })
          }
        } catch (err) {
          if (cancelled) {
            return
          }

          console.error(
            'Trusted contact loading failed:',
            err
          )

          setTrustedContactMessage(
            'Could not load your saved trusted contact.'
          )
        } finally {
          if (!cancelled) {
            setTrustedContactLoading(
              false
            )
          }
        }
      }

    void loadTrustedContact()

    return () => {
      cancelled = true
    }
  }, [user])

  /*
   * AUTOMATIC REROUTING
   */

  const rerouteFromCurrentLocation =
    async (
      currentLocation: [
        number,
        number
      ]
    ) => {
      if (
        !journeyActive ||
        !destination ||
        reroutingRef.current
      ) {
        return
      }

      const now = Date.now()

      if (
        now -
          lastRerouteTimeRef.current <
        REROUTE_COOLDOWN_MS
      ) {
        return
      }

      reroutingRef.current =
        true

      lastRerouteTimeRef.current =
        now

      setGpsStatus(
        'You left the route. Recalculating...'
      )

      try {
        const rawRoutes =
          await getRealRoutes(
            currentLocation,
            destination
          )

        if (!rawRoutes.length) {
          setGpsStatus(
            'Could not find a new route. Continue toward your destination.'
          )

          return
        }

        const rerouteTimestamp =
          Date.now()

        const {
          routes:
            scoredReroutedRoutes,
          checkpointsByRoute,
          balancedIndex,
        } =
          await buildScoredRoutes(
            rawRoutes,
            `reroute-${rerouteTimestamp}`
          )

        const reroutedOptions =
          scoredReroutedRoutes.map(
            (route, index) => {
              if (
                index ===
                balancedIndex
              ) {
                return {
                  ...route,
                  label:
                    'Recalculated route',
                  icon: '🔄',
                }
              }

              if (
                route.label ===
                'Fastest'
              ) {
                return {
                  ...route,
                  label:
                    'Fastest alternative',
                  icon: '⚡',
                }
              }

              return {
                ...route,
                label:
                  `Alternative ${index}`,
                icon: '🛣️',
              }
            }
          )

        const newRoute =
          reroutedOptions[
            balancedIndex
          ]

        if (!newRoute) {
          setGpsStatus(
            'Could not select a recalculated route.'
          )

          return
        }

        setRoutes(
          reroutedOptions
        )

        setSelectedRoute(
          balancedIndex
        )

        const newCheckpoints =
          checkpointsByRoute[
            balancedIndex
          ] ?? []

        setCheckpoints(
          newCheckpoints
        )

        const remaining =
          getRemainingRouteDistance(
            currentLocation,
            newRoute.coordinates
          )

        setRemainingDistance(
          remaining
        )

        const routeSpeed =
          newRoute.duration >
          0
            ? newRoute.distance /
              newRoute.duration
            : 0

        const estimatedSeconds =
          routeSpeed > 0
            ? remaining /
              routeSpeed
            : newRoute.duration

        setRemainingEta(
          estimatedSeconds
        )

        if (
          user &&
          newCheckpoints.length
        ) {
          const checkpointRows =
            newCheckpoints.map(
              (point) => ({
                route_id:
                  point.route_id,
                checkpoint_order:
                  point.checkpoint_order,
                latitude:
                  point.latitude,
                longitude:
                  point.longitude,
                area:
                  point.area,
                city:
                  point.city,
              })
            )

          const {
            error:
              checkpointError,
          } =
            await supabase
              .from(
                'route_checkpoints'
              )
              .insert(
                checkpointRows
              )

          if (
            checkpointError
          ) {
            console.warn(
              'Could not save rerouted checkpoints:',
              checkpointError.message
            )
          }
        }

        deviationCountRef.current =
          0

        setNotice(
          newRoute.safetyScore !==
            null
            ? 'You left the previous route. A new route was calculated using safety context and travel time.'
            : 'You left the previous route. A new route was calculated using travel time because safety data was unavailable.'
        )

        setGpsStatus(
          'Route updated • Live location active'
        )
      } catch (
        rerouteError
      ) {
        console.error(
          'Rerouting failed:',
          rerouteError
        )

        setGpsStatus(
          'Rerouting failed. Continuing with the current route.'
        )
      } finally {
        reroutingRef.current =
          false
      }
    }

  /*
   * LIVE GPS TRACKING
   */

  useEffect(() => {
    if (!journeyActive) {
      if (
        watchIdRef.current !==
        null
      ) {
        navigator.geolocation.clearWatch(
          watchIdRef.current
        )

        watchIdRef.current =
          null
      }

      setUserLocation(
        null
      )

      setRemainingDistance(
        null
      )

      setRemainingEta(
        null
      )

      setGpsStatus('')

      arrivalDetectedRef.current =
        false

      deviationCountRef.current =
        0

      reroutingRef.current =
        false

      return
    }

    if (
      !navigator.geolocation
    ) {
      setGpsStatus(
        'Live location is not supported by this browser.'
      )

      setJourneyActive(
        false
      )

      return
    }

    if (
      selectedRoute ===
        null ||
      !routes[selectedRoute]
    ) {
      setGpsStatus(
        'No selected route is available for navigation.'
      )

      return
    }

    const selectedRouteData =
      routes[selectedRoute]

    arrivalDetectedRef.current =
      false

    deviationCountRef.current =
      0

    setGpsStatus(
      'Getting your live location...'
    )

    const handlePosition =
      (
        position: GeolocationPosition
      ) => {
        /*
         * IMPORTANT TYPE FIX
         *
         * This must be a single coordinate
         * tuple, NOT an array of tuples.
         */
        const currentLocation:
          [number, number] =
          [
            position.coords.latitude,
            position.coords.longitude,
          ]

        const location:
          [number, number] =
          currentLocation

        setUserLocation(
          location
        )

        const nearestRoutePoint =
          getNearestRoutePoint(
            location,
            selectedRouteData.coordinates
          )

        if (
          nearestRoutePoint.distanceFromRoute >
          ROUTE_DEVIATION_THRESHOLD_METERS
        ) {
          deviationCountRef.current +=
            1

          if (
            deviationCountRef.current >=
              ROUTE_DEVIATION_CONFIRMATIONS &&
            !reroutingRef.current
          ) {
            void rerouteFromCurrentLocation(
              location
            )
          }
        } else {
          deviationCountRef.current =
            0
        }

        const remaining =
          getRemainingRouteDistance(
            location,
            selectedRouteData.coordinates
          )

        setRemainingDistance(
          remaining
        )

        const routeSpeed =
          selectedRouteData.duration >
          0
            ? selectedRouteData.distance /
              selectedRouteData.duration
            : 0

        const estimatedSeconds =
          routeSpeed > 0
            ? remaining /
              routeSpeed
            : 0

        setRemainingEta(
          estimatedSeconds
        )

        if (
          !reroutingRef.current
        ) {
          setGpsStatus(
            `Live location active • ±${Math.round(
              position.coords.accuracy
            )} m`
          )
        }

        if (
          destination &&
          distanceInMeters(
            location,
            destination
          ) <= 50 &&
          !arrivalDetectedRef.current
        ) {
          arrivalDetectedRef.current =
            true

          setRemainingDistance(
            0
          )

          setRemainingEta(
            0
          )

          setNotice(
            'You have arrived at your destination.'
          )

          setGpsStatus(
            'Arrived at destination'
          )
        }
      }

    const handlePositionError =
      (
        locationError: GeolocationPositionError
      ) => {
        if (
          locationError.code ===
          locationError.PERMISSION_DENIED
        ) {
          setGpsStatus(
            'Location permission was denied. Enable location access for live navigation.'
          )

          return
        }

        if (
          locationError.code ===
          locationError.POSITION_UNAVAILABLE
        ) {
          setGpsStatus(
            'Your current location is temporarily unavailable. Retrying...'
          )

          return
        }

        if (
          locationError.code ===
          locationError.TIMEOUT
        ) {
          setGpsStatus(
            'GPS request timed out. Retrying...'
          )

          return
        }

        setGpsStatus(
          'Could not determine your current location. Retrying...'
        )
      }

    navigator.geolocation.getCurrentPosition(
      handlePosition,
      handlePositionError,
      {
        enableHighAccuracy:
          true,
        timeout: 30000,
        maximumAge: 10000,
      }
    )

    watchIdRef.current =
      navigator.geolocation.watchPosition(
        handlePosition,
        handlePositionError,
        {
          enableHighAccuracy:
            true,
          timeout: 30000,
          maximumAge: 10000,
        }
      )

    return () => {
      if (
        watchIdRef.current !==
        null
      ) {
        navigator.geolocation.clearWatch(
          watchIdRef.current
        )

        watchIdRef.current =
          null
      }
    }
  }, [
    journeyActive,
    selectedRoute,
    routes,
    destination,
  ])

  /*
   * AUTH
   */

  const handleAuth =
    async () => {
      setError('')
      setNotice('')
      setAuthLoading(
        true
      )

      try {
        if (user) {
          const {
            error:
              signOutError,
          } =
            await supabase.auth.signOut()

          if (signOutError) {
            throw signOutError
          }

          setJourneyActive(
            false
          )

          setSosMessage('')

          setNotice(
            'You have signed out.'
          )
        } else {
          const {
            error:
              signInError,
          } =
            await supabase.auth.signInWithOAuth(
              {
                provider:
                  'google',
                options: {
                  redirectTo:
                    window.location
                      .origin,
                },
              }
            )

          if (signInError) {
            throw signInError
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Authentication failed. Please try again.'
        )
      } finally {
        setAuthLoading(
          false
        )
      }
    }

  /*
   * SAVE TRUSTED CONTACT
   */

  const saveTrustedContact =
    async () => {
      setTrustedContactMessage(
        ''
      )

      if (!user) {
        setTrustedContactMessage(
          'Please sign in first.'
        )

        return
      }

      if (
        !trustedContact.name.trim() ||
        !trustedContact.phone_number.trim()
      ) {
        setTrustedContactMessage(
          'Name and contact number are required.'
        )

        return
      }

      setTrustedContactLoading(
        true
      )

      try {
        const {
          data,
          error,
        } =
          await supabase
            .from(
              'trusted_contacts'
            )
            .upsert(
              {
                user_id:
                  user.id,
                name:
                  trustedContact.name.trim(),
                phone_number:
                  trustedContact.phone_number.trim(),
                email:
                  trustedContact.email.trim() ||
                  null,
                relationship:
                  trustedContact.relationship.trim() ||
                  null,
                is_primary:
                  trustedContact.is_primary,
              },
              {
                onConflict:
                  'user_id',
              }
            )
            .select(
              'id, name, phone_number, email, relationship, is_primary'
            )
            .single()

        if (error) {
          console.error(
            'Could not save trusted contact:',
            error.message
          )

          setTrustedContactMessage(
            'Could not save trusted contact.'
          )

          return
        }

        setTrustedContact({
          id: data.id,
          name:
            data.name ??
            '',
          phone_number:
            data.phone_number ??
            '',
          email:
            data.email ??
            '',
          relationship:
            data.relationship ??
            '',
          is_primary:
            data.is_primary ??
            true,
        })

        setTrustedContactMessage(
          'Trusted contact saved successfully.'
        )
      } catch (err) {
        console.error(
          'Trusted contact save failed:',
          err
        )

        setTrustedContactMessage(
          'Something went wrong while saving the trusted contact.'
        )
      } finally {
        setTrustedContactLoading(
          false
        )
      }
    }

  /*
   * DELETE TRUSTED CONTACT
   */

  const deleteTrustedContact =
    async () => {
      if (
        !user ||
        !trustedContact.id
      ) {
        return
      }

      setTrustedContactLoading(
        true
      )

      setTrustedContactMessage(
        ''
      )

      try {
        const {
          error,
        } =
          await supabase
            .from(
              'trusted_contacts'
            )
            .delete()
            .eq(
              'id',
              trustedContact.id
            )
            .eq(
              'user_id',
              user.id
            )

        if (error) {
          console.error(
            'Could not delete trusted contact:',
            error.message
          )

          setTrustedContactMessage(
            'Could not delete trusted contact.'
          )

          return
        }

        setTrustedContact({
          name: '',
          phone_number:
            '',
          email: '',
          relationship:
            '',
          is_primary:
            true,
        })

        setTrustedContactMessage(
          'Trusted contact removed.'
        )
      } catch (err) {
        console.error(
          'Trusted contact deletion failed:',
          err
        )

        setTrustedContactMessage(
          'Something went wrong while removing the contact.'
        )
      } finally {
        setTrustedContactLoading(
          false
        )
      }
    }

  /*
   * START JOURNEY
   */

  const handleStartJourney =
    () => {
      setError('')
      setNotice('')
      setSosMessage('')

      if (
        selectedRoute ===
          null ||
        !routes[selectedRoute]
      ) {
        setError(
          'Please select a route first.'
        )

        return
      }

      if (!user) {
        setError(
          'Please sign in before starting a journey.'
        )

        return
      }

      if (!trustedContact.id) {
        setError(
          'Please save a trusted contact before starting your journey.'
        )

        return
      }

      if (
        !navigator.geolocation
      ) {
        setError(
          'Live location is not available in this browser.'
        )

        return
      }

      setUserLocation(
        null
      )

      setRemainingDistance(
        null
      )

      setRemainingEta(
        null
      )

      setGpsStatus(
        'Getting your live location...'
      )

      arrivalDetectedRef.current =
        false

      deviationCountRef.current =
        0

      reroutingRef.current =
        false

      lastRerouteTimeRef.current =
        0

      setJourneyActive(
        true
      )

      setNotice(
        'Journey started. Live location and ETA are now active.'
      )
    }

  /*
   * END JOURNEY
   */

  const handleEndJourney =
    () => {
      if (
        watchIdRef.current !==
        null
      ) {
        navigator.geolocation.clearWatch(
          watchIdRef.current
        )

        watchIdRef.current =
          null
      }

      setJourneyActive(
        false
      )

      setUserLocation(
        null
      )

      setRemainingDistance(
        null
      )

      setRemainingEta(
        null
      )

      setGpsStatus('')

      arrivalDetectedRef.current =
        false

      deviationCountRef.current =
        0

      reroutingRef.current =
        false

      lastRerouteTimeRef.current =
        0

      setSosLoading(
        false
      )

      setSosMessage('')

      setNotice(
        'Journey ended.'
      )
    }

  /*
   * SEND SOS WITH LOCATION
   */

  const sendSOSWithLocation =
    async (
      latitude: number,
      longitude: number
    ) => {
      const metadata =
        user?.user_metadata ||
        {}

      const userName =
        metadata.full_name ||
        metadata.name ||
        user?.email ||
        'WhereHo user'

      const locationLink =
        `https://www.google.com/maps?q=${latitude},${longitude}`

      const message =
        `WhereHo SOS: ${userName} may need help. ` +
        `${userName}'s current location is: ${locationLink}. ` +
        `Please check on ${userName}.`

      const phoneNumber =
        trustedContact.phone_number
          .trim()
          .replace(
            /[^\d+]/g,
            ''
          )

      if (!phoneNumber) {
        setSosLoading(
          false
        )

        setSosMessage(
          'The trusted contact phone number is invalid.'
        )

        return
      }

      try {
        if (
          navigator.clipboard
        ) {
          await navigator.clipboard.writeText(
            message
          )
        }
      } catch (
        clipboardError
      ) {
        console.warn(
          'Could not copy SOS message:',
          clipboardError
        )
      }

      const smsUrl =
        `sms:${phoneNumber}?body=${encodeURIComponent(
          message
        )}`

      setSosLoading(
        false
      )

      setSosMessage(
        'SOS ready. Your SMS app will open with your trusted contact, current location and emergency message. Tap Send to alert them. The message has also been copied as a backup.'
      )

      window.setTimeout(
        () => {
          window.location.href =
            smsUrl
        },
        150
      )
    }

  /*
   * SOS
   */

  const handleSOS =
    () => {
      setError('')
      setNotice('')

      if (!user) {
        setSosMessage(
          'Please sign in before using SOS.'
        )

        return
      }

      if (!trustedContact.id) {
        setSosMessage(
          'Please save a trusted contact before using SOS.'
        )

        return
      }

      if (
        !trustedContact.phone_number.trim()
      ) {
        setSosMessage(
          'Your trusted contact does not have a phone number.'
        )

        return
      }

      if (
        !navigator.geolocation
      ) {
        setSosMessage(
          'Location access is not available in this browser.'
        )

        return
      }

      setSosLoading(
        true
      )

      setSosMessage(
        'Getting your current location...'
      )

      if (userLocation) {
        void sendSOSWithLocation(
          userLocation[0],
          userLocation[1]
        )

        return
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          void sendSOSWithLocation(
            position.coords
              .latitude,
            position.coords
              .longitude
          )
        },
        (
          locationError
        ) => {
          setSosLoading(
            false
          )

          if (
            locationError.code ===
            locationError.PERMISSION_DENIED
          ) {
            setSosMessage(
              'Location permission was denied. Please allow location access to use SOS.'
            )
          } else if (
            locationError.code ===
            locationError.POSITION_UNAVAILABLE
          ) {
            setSosMessage(
              'Your current location could not be determined. Please try again.'
            )
          } else if (
            locationError.code ===
            locationError.TIMEOUT
          ) {
            setSosMessage(
              'GPS is taking too long to respond. Please try again or move to an area with a clearer GPS signal.'
            )
          } else {
            setSosMessage(
              'Could not get your current location. Please try again.'
            )
          }
        },
        {
          enableHighAccuracy:
            true,
          timeout: 30000,
          maximumAge: 10000,
        }
      )
    }

  /*
   * FIND ROUTES
   */

  const handleFindRoutes =
    async (
      event: FormEvent
    ) => {
      event.preventDefault()

      selectionRequestRef.current +=
        1

      setError('')
      setNotice('')
      setLoading(true)

      setRoutes([])

      setSelectedRoute(
        null
      )

      setCheckpoints([])

      setSafetyData(
        null
      )

      setJourneyActive(
        false
      )

      setUserLocation(
        null
      )

      setRemainingDistance(
        null
      )

      setRemainingEta(
        null
      )

      setGpsStatus('')

      deviationCountRef.current =
        0

      reroutingRef.current =
        false

      lastRerouteTimeRef.current =
        0

      setSosLoading(
        false
      )

      setSosMessage('')

      try {
        if (
          !origin.trim() ||
          !destinationText.trim()
        ) {
          throw new Error(
            'Enter both a starting point and a destination.'
          )
        }

        const [
          originLocation,
          destinationLocation,
        ] =
          await Promise.all([
            geocodeLocation(
              origin.trim()
            ),
            geocodeLocation(
              destinationText.trim()
            ),
          ])

        setStart(
          originLocation.coordinates
        )

        setDestination(
          destinationLocation.coordinates
        )

        setDestinationCity(
          destinationLocation.city
        )

        const rawRoutes =
          await getRealRoutes(
            originLocation.coordinates,
            destinationLocation.coordinates
          )

        if (!rawRoutes.length) {
          throw new Error(
            'No routes were found for these locations.'
          )
        }

        let foundSafetyData:
          | SafetyData
          | null = null

        if (
          destinationLocation.city
        ) {
          const cityContext =
            await lookupCityCrimeContext(
              destinationLocation.city
            )

          if (cityContext) {
            foundSafetyData = {
              city:
                destinationLocation.city,
              year:
                cityContext.city_data_year,
              women_crime_rate:
                cityContext.city_women_crime_rate,
              data_confidence:
                cityContext.city_data_confidence,
              source:
                cityContext.city_data_source,
            }
          }
        }

        setSafetyData(
          foundSafetyData
        )

        const routeTimestamp =
          Date.now()

        const {
          routes:
            scoredRoutes,
          checkpointsByRoute,
          balancedIndex,
        } =
          await buildScoredRoutes(
            rawRoutes,
            `route-${routeTimestamp}`
          )

        setRoutes(
          scoredRoutes
        )

        setSelectedRoute(
          balancedIndex
        )

        const selectedRouteCheckpoints =
          checkpointsByRoute[
            balancedIndex
          ] ?? []

        setCheckpoints(
          selectedRouteCheckpoints
        )

        if (user) {
          const checkpointRows =
            checkpointsByRoute.flatMap(
              (
                routePoints
              ) =>
                routePoints.map(
                  (point) => ({
                    route_id:
                      point.route_id,
                    checkpoint_order:
                      point.checkpoint_order,
                    latitude:
                      point.latitude,
                    longitude:
                      point.longitude,
                    area:
                      point.area,
                    city:
                      point.city,
                  })
                )
            )

          if (
            checkpointRows.length
          ) {
            const {
              error:
                checkpointError,
            } =
              await supabase
                .from(
                  'route_checkpoints'
                )
                .insert(
                  checkpointRows
                )

            if (
              checkpointError
            ) {
              console.warn(
                'Could not save route checkpoints:',
                checkpointError.message
              )

              setNotice(
                'Routes found, but checkpoints could not be saved to Supabase.'
              )
            } else {
              setNotice(
                'Routes ranked using available safety context and travel time.'
              )
            }
          }
        } else {
          setNotice(
            'Routes ranked using available safety context and travel time. Sign in to save checkpoints to Supabase.'
          )
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Something went wrong while finding routes.'
        )
      } finally {
        setLoading(
          false
        )
      }
    }

  /*
   * SELECT ROUTE
   */

  const handleSelectRoute =
    async (
      index: number
    ) => {
      const route =
        routes[index]

      if (!route) {
        return
      }

      const requestId =
        ++selectionRequestRef.current

      setSelectedRoute(
        index
      )

      setJourneyActive(
        false
      )

      setUserLocation(
        null
      )

      setRemainingDistance(
        null
      )

      setRemainingEta(
        null
      )

      setGpsStatus('')

      setSosMessage('')

      deviationCountRef.current =
        0

      reroutingRef.current =
        false

      lastRerouteTimeRef.current =
        0

      const basicCheckpoints =
        generateCheckpoints(
          route.coordinates,
          route.routeId
        )

      setCheckpoints(
        basicCheckpoints
      )

      const localisedCheckpoints =
        await enrichCheckpoints(
          basicCheckpoints
        )

      const enrichedCheckpoints =
        await enrichCheckpointSafety(
          localisedCheckpoints
        )

      if (
        requestId !==
        selectionRequestRef.current
      ) {
        return
      }

      setCheckpoints(
        enrichedCheckpoints
      )

      const updatedSafetyScore =
        calculateRouteSafetyScore(
          enrichedCheckpoints
        )

      setRoutes(
        (currentRoutes) => {
          const fastestDuration =
            Math.min(
              ...currentRoutes.map(
                (item) =>
                  item.duration
              )
            )

          return currentRoutes.map(
            (
              currentRoute,
              routeIndex
            ) => {
              if (
                routeIndex !==
                index
              ) {
                return currentRoute
              }

              const timeScore =
                fastestDuration >
                0
                  ? (fastestDuration /
                      currentRoute.duration) *
                    100
                  : 100

              const recommendationScore =
                updatedSafetyScore !==
                null
                  ? Math.round(
                      updatedSafetyScore *
                        SAFETY_WEIGHT +
                        timeScore *
                          TIME_WEIGHT
                    )
                  : Math.round(
                      timeScore
                    )

              return {
                ...currentRoute,
                safetyScore:
                  updatedSafetyScore,
                recommendationScore,
              }
            }
          )
        }
      )

      if (!user) {
        return
      }

      let updateFailed =
        false

      for (
        const point of
        enrichedCheckpoints
      ) {
        const {
          error:
            updateError,
        } =
          await supabase
            .from(
              'route_checkpoints'
            )
            .update({
              area:
                point.area,
              city:
                point.city,
            })
            .eq(
              'route_id',
              route.routeId
            )
            .eq(
              'checkpoint_order',
              point.checkpoint_order
            )

        if (
          updateError
        ) {
          console.warn(
            'Could not update checkpoint locality:',
            updateError.message
          )

          updateFailed = true
        }
      }

      if (
        requestId !==
        selectionRequestRef.current
      ) {
        return
      }

      setNotice(
        updateFailed
          ? 'Locality details were found, but some could not be saved.'
          : 'Checkpoint locality details updated.'
      )
    }

  return (
    <main className="app-container">

      {/* HEADER */}

      <header className="app-header">

        <div className="brand">

          <h1>
            Whereहो
          </h1>

          <p>
            Plan your journey with safety context.
          </p>

        </div>

        <button
          type="button"
          onClick={
            handleAuth
          }
          disabled={
            authLoading
          }
          className="auth-button"
        >
          {authLoading
            ? 'Please wait...'
            : user
              ? 'Sign out'
              : 'Sign in with Google'}
        </button>

      </header>

      {/* TRUSTED CONTACT */}

      {user && (
        <section className="trusted-contact-section">

          <div className="trusted-contact-header">

            <div
              className="trusted-contact-icon"
              aria-hidden="true"
            >
              ♡
            </div>

            <div>

              <div className="trusted-contact-title-row">

                <h2>
                  Trusted Contact
                </h2>

                {trustedContact.id && (
                  <span className="trusted-contact-saved">
                    Saved
                  </span>
                )}

              </div>

              <p>
                Someone you trust who can receive
                your location if you need help
                during your journey.
              </p>

            </div>

          </div>

          <form
            className="trusted-contact-form"
            onSubmit={(
              event
            ) => {
              event.preventDefault()

              void saveTrustedContact()
            }}
          >

            <div className="trusted-contact-fields">

              <div className="trusted-field">

                <label htmlFor="trusted-name">
                  Contact name
                </label>

                <input
                  id="trusted-name"
                  type="text"
                  value={
                    trustedContact.name
                  }
                  onChange={(
                    event
                  ) =>
                    setTrustedContact({
                      ...trustedContact,
                      name:
                        event.target.value,
                    })
                  }
                  placeholder="e.g. Parent, sibling or friend"
                  autoComplete="name"
                />

              </div>

              <div className="trusted-field">

                <label htmlFor="trusted-phone">
                  Contact number
                </label>

                <input
                  id="trusted-phone"
                  type="tel"
                  value={
                    trustedContact.phone_number
                  }
                  onChange={(
                    event
                  ) =>
                    setTrustedContact({
                      ...trustedContact,
                      phone_number:
                        event.target.value,
                    })
                  }
                  placeholder="+91 XXXXX XXXXX"
                  autoComplete="tel"
                />

              </div>

              <div className="trusted-field">

                <label htmlFor="trusted-email">

                  Email address

                  <span>
                    Optional
                  </span>

                </label>

                <input
                  id="trusted-email"
                  type="email"
                  value={
                    trustedContact.email
                  }
                  onChange={(
                    event
                  ) =>
                    setTrustedContact({
                      ...trustedContact,
                      email:
                        event.target.value,
                    })
                  }
                  placeholder="name@example.com"
                  autoComplete="email"
                />

              </div>

              <div className="trusted-field">

                <label htmlFor="trusted-relationship">

                  Relationship

                  <span>
                    Optional
                  </span>

                </label>

                <input
                  id="trusted-relationship"
                  type="text"
                  value={
                    trustedContact.relationship
                  }
                  onChange={(
                    event
                  ) =>
                    setTrustedContact({
                      ...trustedContact,
                      relationship:
                        event.target.value,
                    })
                  }
                  placeholder="e.g. Parent, sibling, friend"
                />

              </div>

            </div>

            <div className="trusted-contact-footer">

              <label className="primary-contact-toggle">

                <input
                  type="checkbox"
                  checked={
                    trustedContact.is_primary
                  }
                  onChange={(
                    event
                  ) =>
                    setTrustedContact({
                      ...trustedContact,
                      is_primary:
                        event.target.checked,
                    })
                  }
                />

                <span className="primary-contact-check">
                  ✓
                </span>

                <span>

                  <strong>
                    Primary trusted contact
                  </strong>

                  <small>
                    Use this person first when SOS is triggered.
                  </small>

                </span>

              </label>

              <div className="trusted-contact-actions">

                {trustedContact.id && (
                  <button
                    type="button"
                    className="trusted-remove-button"
                    onClick={() =>
                      void deleteTrustedContact()
                    }
                    disabled={
                      trustedContactLoading
                    }
                  >
                    Remove
                  </button>
                )}

                <button
                  type="submit"
                  className="trusted-save-button"
                  disabled={
                    trustedContactLoading
                  }
                >
                  {trustedContactLoading
                    ? 'Saving...'
                    : trustedContact.id
                      ? 'Update contact'
                      : 'Save contact'}
                </button>

              </div>

            </div>

            {trustedContactMessage && (
              <div
                className={`trusted-contact-message ${
                  trustedContactMessage.includes(
                    'successfully'
                  ) ||
                  trustedContactMessage.includes(
                    'removed'
                  )
                    ? 'success'
                    : 'error'
                }`}
                role="status"
              >

                <span>
                  {trustedContactMessage.includes(
                    'successfully'
                  ) ||
                  trustedContactMessage.includes(
                    'removed'
                  )
                    ? '✓'
                    : '!'}
                </span>

                {trustedContactMessage}

              </div>
            )}

          </form>

          <div className="trusted-contact-note">

            <span aria-hidden="true">
              🔒
            </span>

            <span>
              Your trusted contact is private and
              is only used for Whereहो's emergency
              contact features.
            </span>

          </div>

        </section>
      )}

      {/* ROUTE SEARCH */}

      <section className="search-section">

        <h2>
          Find your route
        </h2>

        <form
          onSubmit={
            handleFindRoutes
          }
          className="route-form"
        >

          <label htmlFor="origin">
            Starting point
          </label>

          <input
            id="origin"
            type="text"
            value={origin}
            onChange={(
              event
            ) =>
              setOrigin(
                event.target.value
              )
            }
            placeholder="Enter starting location"
            autoComplete="street-address"
            required
          />

          <label htmlFor="destination">
            Destination
          </label>

          <input
            id="destination"
            type="text"
            value={
              destinationText
            }
            onChange={(
              event
            ) =>
              setDestinationText(
                event.target.value
              )
            }
            placeholder="Enter destination"
            autoComplete="street-address"
            required
          />

          <button
            type="submit"
            disabled={
              loading
            }
          >
            {loading
              ? 'Finding routes...'
              : 'Find routes'}
          </button>

        </form>

        {error && (
          <p
            className="error-message"
            role="alert"
          >
            {error}
          </p>
        )}

        {notice && (
          <p
            className="status-message"
            role="status"
          >
            {notice}
          </p>
        )}

      </section>

      {/* ROUTE RESULTS */}

      {routes.length > 0 && (
        <section className="results-section">

          <h2>
            Available routes
          </h2>

          <p className="location-summary">

            <strong>
              From:
            </strong>{' '}

            {origin.trim()}

            <br />

            <strong>
              To:
            </strong>{' '}

            {destinationText.trim()}

          </p>

          {safetyData ? (

            <div className="safety-summary">

              <h3>
                Destination city crime context
              </h3>

              <p>

                <strong>
                  {safetyData.city}
                </strong>

                {' — derived comparison estimate: '}

                {calculateSafetyScore(
                  Number(
                    safetyData.women_crime_rate
                  )
                )}

                /100

              </p>

              <p>

                Reported women’s crime rate:{' '}

                {Number(
                  safetyData.women_crime_rate
                ).toFixed(1)}

              </p>

              <p>

                Data year:{' '}

                {safetyData.year}

              </p>

              <p>

                Data confidence:{' '}

                {safetyData.data_confidence ??
                  'Not specified'}

              </p>

              {safetyData.source && (
                <p>

                  Source:{' '}

                  {safetyData.source}

                </p>
              )}

              <p className="route-analysis">

                The comparison estimate is calculated
                from city-level reported crime data.
                It is not an official safety rating,
                does not describe individual streets,
                and does not guarantee safety. Where
                available, sourced neighbourhood data
                is given priority when ranking routes.

              </p>

            </div>

          ) : (

            <p className="route-analysis">

              No matching city-level crime record was
              found for
              {destinationCity
                ? ` ${destinationCity}`
                : ' the destination'}.

              Route recommendations use available
              safety context and travel time. Missing
              safety data does not mean that a route
              is unsafe.

            </p>

          )}

          {/* ROUTE CARDS */}

          <div className="route-list">

            {routes.map(
              (
                route,
                index
              ) => (

                <button
                  type="button"
                  key={
                    route.routeId
                  }
                  className={`route-card ${
                    selectedRoute ===
                    index
                      ? 'selected'
                      : ''
                  }`}
                  onClick={() =>
                    void handleSelectRoute(
                      index
                    )
                  }
                  aria-pressed={
                    selectedRoute ===
                    index
                  }
                >

                  <div className="route-card-header">

                    <span className="route-icon">
                      {route.icon}
                    </span>

                    <strong>
                      {route.label}
                    </strong>

                    {selectedRoute ===
                      index && (
                      <span className="selected-label">
                        Selected
                      </span>
                    )}

                  </div>

                  <p>

                    <strong>
                      Distance:
                    </strong>{' '}

                    {formatDistance(
                      route.distance
                    )}

                  </p>

                  <p>

                    <strong>
                      Estimated travel time:
                    </strong>{' '}

                    {formatDuration(
                      route.duration
                    )}

                  </p>

                  <p>

                    <strong>
                      Recommendation score:
                    </strong>{' '}

                    {route.recommendationScore}
                    /100

                  </p>

                  <p>

                    <strong>
                      Safety context:
                    </strong>{' '}

                    {route.safetyScore !==
                    null
                      ? `${route.safetyScore}/100`
                      : 'Not available'}

                  </p>

                  <p
                    style={{
                      fontSize:
                        '12px',
                      color:
                        '#64748b',
                      marginTop:
                        '8px',
                    }}
                  >
                    Safety uses available sourced
                    neighbourhood data first, with
                    city-level context used only when
                    neighbourhood data is unavailable.
                  </p>

                </button>

              )
            )}

          </div>

          {/* START JOURNEY */}

          {!journeyActive &&
            selectedRoute !==
              null && (

              <div className="journey-start-panel">

                <div>

                  <strong>
                    Ready to start?
                  </strong>

                  <p>
                    Start your journey to enable
                    live navigation and SOS.
                  </p>

                </div>

                <button
                  type="button"
                  className="start-journey-button"
                  onClick={
                    handleStartJourney
                  }
                >
                  Start Journey
                </button>

              </div>

            )}

          {/* ACTIVE JOURNEY */}

          {journeyActive && (

            <div className="active-journey-panel">

              <div className="active-journey-info">

                <span
                  className="journey-live-dot"
                  aria-hidden="true"
                />

                <div>

                  <strong>
                    Journey active
                  </strong>

                  <p>
                    Live navigation is following
                    your selected route.
                  </p>

                </div>

              </div>

              {/* LIVE ETA */}

              <div
                style={{
                  display:
                    'grid',
                  gridTemplateColumns:
                    'repeat(2, minmax(0, 1fr))',
                  gap: '12px',
                  marginTop:
                    '16px',
                  marginBottom:
                    '16px',
                }}
              >

                <div
                  style={{
                    padding:
                      '14px',
                    borderRadius:
                      '12px',
                    background:
                      '#f0fdf4',
                    border:
                      '1px solid #bbf7d0',
                  }}
                >

                  <div
                    style={{
                      fontSize:
                        '12px',
                      color:
                        '#166534',
                      fontWeight:
                        600,
                      marginBottom:
                        '4px',
                    }}
                  >
                    REMAINING
                  </div>

                  <strong
                    style={{
                      fontSize:
                        '22px',
                    }}
                  >
                    {remainingDistance !==
                    null
                      ? formatDistance(
                          remainingDistance
                        )
                      : 'Locating...'}
                  </strong>

                </div>

                <div
                  style={{
                    padding:
                      '14px',
                    borderRadius:
                      '12px',
                    background:
                      '#eff6ff',
                    border:
                      '1px solid #bfdbfe',
                  }}
                >

                  <div
                    style={{
                      fontSize:
                        '12px',
                      color:
                        '#1d4ed8',
                      fontWeight:
                        600,
                      marginBottom:
                        '4px',
                    }}
                  >
                    ETA
                  </div>

                  <strong
                    style={{
                      fontSize:
                        '22px',
                    }}
                  >
                    {remainingEta !==
                    null
                      ? formatDuration(
                          remainingEta
                        )
                      : 'Calculating...'}
                  </strong>

                </div>

              </div>

              {gpsStatus && (
                <p
                  style={{
                    fontSize:
                      '13px',
                    margin:
                      '0 0 12px',
                    color:
                      gpsStatus.includes(
                        'active'
                      ) ||
                      gpsStatus.includes(
                        'Arrived'
                      ) ||
                      gpsStatus.includes(
                        'updated'
                      )
                        ? '#166534'
                        : '#64748b',
                  }}
                >
                  📍 {gpsStatus}
                </p>
              )}

              <div className="active-journey-actions">

                <button
                  type="button"
                  className="sos-button"
                  onClick={
                    handleSOS
                  }
                  disabled={
                    sosLoading
                  }
                  aria-label="Emergency SOS"
                >

                  <span className="sos-button-icon">
                    SOS
                  </span>

                  <span>
                    {sosLoading
                      ? 'Locating...'
                      : 'Emergency SOS'}
                  </span>

                </button>

                <button
                  type="button"
                  className="end-journey-button"
                  onClick={
                    handleEndJourney
                  }
                >
                  End Journey
                </button>

              </div>

            </div>

          )}

          {sosMessage && (

            <div
              className="sos-status-message"
              role="status"
            >
              {sosMessage}
            </div>

          )}

          {/* CHECKPOINTS */}

          {checkpoints.length >
            0 && (

            <div className="checkpoint-summary">

              <h3>
                Route checkpoints
              </h3>

              <p>
                {checkpoints.length} numbered points
                are shown on the selected route.
              </p>

              <ul>

                {checkpoints.map(
                  (
                    point
                  ) => (

                    <li
                      key={`${point.route_id}-${point.checkpoint_order}`}
                    >

                      <strong>
                        Checkpoint{' '}
                        {
                          point.checkpoint_order
                        }:
                      </strong>{' '}

                      {point.area ||
                        point.city ||
                        'Locality not available'}

                      {point.area &&
                        point.city &&
                        point.area.toLowerCase() !==
                          point.city.toLowerCase()
                        ? `, ${point.city}`
                        : ''}

                      {point.area_safety_score !==
                      null ? (

                        <>

                          <p>

                            <strong>
                              Neighbourhood safety data
                              score:
                            </strong>{' '}

                            {
                              point.area_safety_score
                            }
                            /100

                          </p>

                          <p>

                            Confidence:{' '}

                            {point.area_safety_confidence ??
                              'Not specified'}

                          </p>

                          {point.area_safety_source && (
                            <p>

                              Source:{' '}

                              {
                                point.area_safety_source
                              }

                            </p>
                          )}

                        </>

                      ) : point.city_women_crime_rate !==
                        null ? (

                        <>

                          <p>

                            <strong>
                              City-level crime context:
                            </strong>{' '}

                            Reported women’s crime rate{' '}

                            {point.city_women_crime_rate.toFixed(
                              1
                            )}

                          </p>

                          <p>

                            Data year:{' '}

                            {point.city_data_year ??
                              'Not specified'}

                          </p>

                          <p>

                            Confidence:{' '}

                            {point.city_data_confidence ??
                              'Not specified'}

                          </p>

                          {point.city_data_source && (
                            <p>

                              Source:{' '}

                              {
                                point.city_data_source
                              }

                            </p>
                          )}

                          <p className="route-analysis">

                            City-level data does not measure
                            the safety of this specific
                            neighbourhood or checkpoint.

                          </p>

                        </>

                      ) : (

                        <p>
                          Neighbourhood and city crime
                          data unavailable.
                        </p>

                      )}

                    </li>

                  )
                )}

              </ul>

              <p className="route-analysis">

                Neighbourhood records are used first
                when a nearby record has a valid score
                and source. City-level crime rates are
                used only when neighbourhood data is
                unavailable. Missing data does not mean
                that a route or area is unsafe.

              </p>

            </div>

          )}

        </section>
      )}

      {/* MAP */}

      <section className="map-section">

        <h2>
          Route map
        </h2>

        <MapView
          start={start}
          destination={
            destination
          }
          routes={routes}
          selectedRoute={
            selectedRoute
          }
          checkpoints={
            checkpoints
          }
          userLocation={
            userLocation
          }
          isNavigating={
            journeyActive
          }
        />

      </section>

      {/* FOOTER */}

      <footer className="app-footer">

        <p>
          Whereहो provides route planning and limited
          city-level crime context. It cannot verify
          the safety of an individual road. Use current
          local information when travelling.
        </p>

        <p>
          Mapping data © OpenStreetMap contributors.
          Routes provided by OSRM.
        </p>

      </footer>

    </main>
  )
}

export default App