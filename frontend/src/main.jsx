import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.jsx'
import { TrackingLayout } from './features/tracking/TrackingLayout.jsx'
import { TrackingHome } from './features/tracking/pages/Home.jsx'
import { EventsPage } from './features/tracking/pages/Events.jsx'
import { EventDetailPage } from './features/tracking/pages/EventDetail.jsx'
import { PlayersPage } from './features/tracking/pages/Players.jsx'
import { PlayerDetailPage } from './features/tracking/pages/PlayerDetail.jsx'
import { DonationsPage } from './features/tracking/pages/Donations.jsx'
import { PlayerStatsPage } from './features/tracking/pages/PlayerStats.jsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 60 * 5, retry: 1 },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/tracking" element={<TrackingLayout />}>
            <Route index element={<TrackingHome />} />
            <Route path="alliances/:allianceId">
              <Route path="events" element={<EventsPage />} />
              <Route path="events/:eventId" element={<EventDetailPage />} />
              <Route path="players" element={<PlayersPage />} />
              <Route path="players/:playerId" element={<PlayerDetailPage />} />
              <Route path="donations" element={<DonationsPage />} />
              <Route path="stats" element={<PlayerStatsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
