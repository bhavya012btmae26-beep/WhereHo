import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

type UserMetadata = {
  full_name?: string
  name?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders,
    })
  }

  try {
    const { latitude, longitude } =
      await req.json()

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number'
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            'Valid latitude and longitude are required.',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid location coordinates.',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const supabaseUrl =
      Deno.env.get('SUPABASE_URL')

    const supabaseKey =
      Deno.env.get('SUPABASE_ANON_KEY') ||
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY')

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Supabase environment variables are missing.'
      )
    }

    const authorization =
      req.headers.get('Authorization')

    if (!authorization) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Authorization is required.',
        }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const supabase = createClient(
      supabaseUrl,
      supabaseKey,
      {
        global: {
          headers: {
            Authorization: authorization,
          },
        },
      }
    )

    const {
      data: {
        user,
      },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      console.error(
        'Authentication error:',
        userError
      )

      return new Response(
        JSON.stringify({
          success: false,
          error: 'User is not authenticated.',
        }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const {
      data: trustedContact,
      error: contactError,
    } = await supabase
      .from('trusted_contacts')
      .select(
        'name, phone_number, is_primary'
      )
      .eq('user_id', user.id)
      .order('is_primary', {
        ascending: false,
      })
      .limit(1)
      .maybeSingle()

    if (contactError) {
      console.error(
        'Trusted contact lookup failed:',
        contactError
      )

      throw new Error(
        'Could not load your trusted contact.'
      )
    }

    if (!trustedContact) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            'No trusted contact is saved.',
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const metadata =
      (user.user_metadata || {}) as UserMetadata

    const userName =
      metadata.full_name ||
      metadata.name ||
      user.email ||
      'WhereHo user'

    const locationLink =
      `https://www.google.com/maps?q=${latitude},${longitude}`

    console.log('SOS TEST EVENT', {
      userId: user.id,
      userName,
      trustedContactName:
        trustedContact.name,
      latitude,
      longitude,
      locationLink,
    })

    return new Response(
      JSON.stringify({
        success: true,
        test: true,
        message:
          'SOS backend test successful. No SMS was sent.',
        trustedContact:
          trustedContact.name,
        locationLink,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    )
  } catch (error) {
    console.error(
      'SOS test error:',
      error
    )

    return new Response(
      JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'SOS test failed.',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    )
  }
})