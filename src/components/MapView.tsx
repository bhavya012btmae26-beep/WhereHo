import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

type RouteOption = {
  coordinates: [number, number][]
  distance: number
  duration: number
  label: string
  icon: string
  recommendationScore: number
  routeId: string
}

type RouteCheckpoint = {
  route_id: string
  checkpoint_order: number
  latitude: number
  longitude: number
  area: string | null
  city: string | null

  area_safety_score: number | null
  area_safety_confidence: 'high' | 'medium' | 'low' | null
  area_safety_source: string | null

  city_women_crime_rate: number | null
  city_data_year: number | null
  city_data_confidence: 'high' | 'medium' | 'low' | null
  city_data_source: string | null
}

type MapViewProps = {
  start: [number, number] | null
  destination: [number, number] | null
  routes: RouteOption[]
  selectedRoute: number | null
  checkpoints: RouteCheckpoint[]

  userLocation?: [number, number] | null
  isNavigating?: boolean
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }

    return entities[character]
  })

const safeText = (value: string | null | undefined): string =>
  value?.trim() ? escapeHtml(value) : 'Not available'

function MapView({
  start,
  destination,
  routes,
  selectedRoute,
  checkpoints,
  userLocation = null,
  isNavigating = false,
}: MapViewProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)

  const routeLayersRef = useRef<L.Polyline[]>([])
  const markerLayersRef = useRef<L.Marker[]>([])
  const checkpointLayersRef = useRef<L.Marker[]>([])

  const userMarkerRef = useRef<L.Marker | null>(null)
  const hasCenteredOnUserRef = useRef(false)

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return

    const map = L.map(mapElementRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
    })

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }
    ).addTo(map)

    mapRef.current = map

    const resizeTimer = window.setTimeout(
      () => map.invalidateSize(),
      250
    )

    return () => {
      window.clearTimeout(resizeTimer)

      if (userMarkerRef.current) {
        userMarkerRef.current.remove()
        userMarkerRef.current = null
      }

      map.remove()
      mapRef.current = null
    }
  }, [])

  /*
   * LIVE USER LOCATION
   *
   * This effect only updates the user's marker.
   * It does not redraw the routes or checkpoints.
   */
  useEffect(() => {
    const map = mapRef.current

    if (!map) return

    if (!userLocation) {
      if (userMarkerRef.current) {
        userMarkerRef.current.remove()
        userMarkerRef.current = null
      }

      hasCenteredOnUserRef.current = false
      return
    }

    const userIcon = L.divIcon({
      className: '',
      html: `
        <div style="
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #2563eb;
          border: 4px solid white;
          box-shadow:
            0 0 0 2px #2563eb,
            0 2px 8px rgba(0,0,0,0.35);
        "></div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    })

    if (!userMarkerRef.current) {
      userMarkerRef.current = L.marker(userLocation, {
        icon: userIcon,
        zIndexOffset: 1000,
      })
        .addTo(map)
        .bindPopup('Your current location')
    } else {
      userMarkerRef.current.setLatLng(userLocation)
    }

    /*
     * When navigation starts, center the map on the user once.
     * After that, follow the user as they move.
     */
    if (isNavigating) {
      if (!hasCenteredOnUserRef.current) {
        map.setView(userLocation, 16)
        hasCenteredOnUserRef.current = true
      } else {
        const currentCenter = map.getCenter()

        const distanceFromCenter = map.distance(
          currentCenter,
          L.latLng(userLocation)
        )

        /*
         * Only move the map if the user has moved
         * significantly away from the current map center.
         */
        if (distanceFromCenter > 80) {
          map.panTo(userLocation, {
            animate: true,
            duration: 0.5,
          })
        }
      }
    }
  }, [userLocation, isNavigating])

  /*
   * ROUTES, START, DESTINATION AND CHECKPOINTS
   */
  useEffect(() => {
    const map = mapRef.current

    if (!map) return

    routeLayersRef.current.forEach((layer) => layer.remove())
    routeLayersRef.current = []

    markerLayersRef.current.forEach((marker) => marker.remove())
    markerLayersRef.current = []

    checkpointLayersRef.current.forEach((marker) => marker.remove())
    checkpointLayersRef.current = []

    if (start) {
      const marker = L.marker(start)
        .addTo(map)
        .bindPopup('Starting location')

      markerLayersRef.current.push(marker)
    }

    if (destination) {
      const marker = L.marker(destination)
        .addTo(map)
        .bindPopup('Destination')

      markerLayersRef.current.push(marker)
    }

    routes.forEach((route, index) => {
      const selected = index === selectedRoute

      const line = L.polyline(route.coordinates, {
        color: selected ? '#15803d' : '#64748b',
        weight: selected ? 7 : 4,
        opacity: selected ? 1 : 0.35,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map)

      routeLayersRef.current.push(line)
    })

    checkpoints.forEach((checkpoint) => {
      const checkpointIcon = L.divIcon({
        className: '',
        html: `
          <div style="
            width: 26px;
            height: 26px;
            border-radius: 50%;
            background: white;
            border: 2px solid #2563eb;
            color: #1d4ed8;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 12px;
            box-shadow: 0 1px 5px #0003;
          ">${checkpoint.checkpoint_order}</div>
        `,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })

      const area = checkpoint.area?.trim()
        ? escapeHtml(checkpoint.area)
        : null

      const city = checkpoint.city?.trim()
        ? escapeHtml(checkpoint.city)
        : null

      const locality =
        area || city
          ? [area, city]
              .filter(
                (value, index, values) =>
                  value &&
                  values.indexOf(value) === index
              )
              .join(', ')
          : 'Locality not available'

      const score = checkpoint.area_safety_score

      const hasAreaRecord =
        score !== null &&
        Number.isFinite(score) &&
        Boolean(checkpoint.area_safety_source?.trim())

      let safetyDetails = ''

      if (hasAreaRecord) {
        safetyDetails = `
          <div style="margin-bottom: 8px;">
            <strong>Neighbourhood data</strong>
            <div><strong>Recorded score:</strong> ${score}/100</div>
            <div><strong>Confidence:</strong> ${safeText(
              checkpoint.area_safety_confidence
            )}</div>
            <div><strong>Source:</strong> ${safeText(
              checkpoint.area_safety_source
            )}</div>
          </div>
        `
      } else if (
        checkpoint.city_women_crime_rate !== null &&
        Number.isFinite(checkpoint.city_women_crime_rate)
      ) {
        safetyDetails = `
          <div style="margin-bottom: 8px;">
            <strong>City-level crime context</strong>
            <div><strong>Reported rate:</strong> ${
              checkpoint.city_women_crime_rate
            }</div>
            <div><strong>Data year:</strong> ${
              checkpoint.city_data_year ?? 'Not available'
            }</div>
            <div><strong>Confidence:</strong> ${safeText(
              checkpoint.city_data_confidence
            )}</div>
            <div><strong>Source:</strong> ${safeText(
              checkpoint.city_data_source
            )}</div>
            <p style="font-size: 11px; margin: 4px 0 0;">
              This is city-level reported crime data, not a neighbourhood
              or road safety score.
            </p>
          </div>
        `
      } else {
        safetyDetails = `
          <div style="margin-bottom: 8px;">
            <strong>Safety data not available</strong>
            <p style="font-size: 12px; margin: 4px 0 0;">
              No matching sourced neighbourhood or city record was found
              for this checkpoint. This does not mean the area is unsafe.
            </p>
          </div>
        `
      }

      const popupContent = `
        <div style="min-width: 190px; max-width: 260px; line-height: 1.5;">
          <strong>Checkpoint ${checkpoint.checkpoint_order}</strong>
          <hr style="margin: 6px 0;" />

          <div><strong>Locality:</strong> ${locality}</div>

          <div>
            <strong>Latitude:</strong>
            ${checkpoint.latitude.toFixed(5)}
          </div>

          <div>
            <strong>Longitude:</strong>
            ${checkpoint.longitude.toFixed(5)}
          </div>

          <hr style="margin: 6px 0;" />

          ${safetyDetails}

          <p style="font-size: 11px; margin-bottom: 0;">
            Data may be incomplete or delayed and is not a real-time
            safety guarantee.
          </p>
        </div>
      `

      const marker = L.marker(
        [checkpoint.latitude, checkpoint.longitude],
        {
          icon: checkpointIcon,
        }
      )
        .addTo(map)
        .bindPopup(popupContent)

      checkpointLayersRef.current.push(marker)
    })

    /*
     * Only fit the route when we are NOT actively navigating.
     *
     * During navigation the map should follow the user instead
     * of constantly zooming back to the complete route.
     */
    if (!isNavigating) {
      if (
        selectedRoute !== null &&
        routes[selectedRoute]?.coordinates.length
      ) {
        map.fitBounds(
          L.latLngBounds(
            routes[selectedRoute].coordinates
          ),
          {
            padding: [40, 40],
          }
        )
      } else if (start && destination) {
        map.fitBounds(
          L.latLngBounds([start, destination]),
          {
            padding: [50, 50],
          }
        )
      }
    }

    const resizeTimer = window.setTimeout(
      () => map.invalidateSize(),
      100
    )

    return () => window.clearTimeout(resizeTimer)
  }, [
    start,
    destination,
    routes,
    selectedRoute,
    checkpoints,
    isNavigating,
  ])

  return (
    <div
      ref={mapElementRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '500px',
      }}
    />
  )
}

export default MapView