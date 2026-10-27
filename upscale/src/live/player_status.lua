local utils = require "mp.utils"
local path = os.getenv("DLSS5_LIVE_PLAYER_STATE")
if path then
    local stalls, was_stalled, started = 0, false, false
    local max_av, max_drop, max_decoder_drop, last_position, last_duration = 0, 0, 0, 0, 0
    local function save(ended, reason)
        local stalled = mp.get_property_bool("paused-for-cache", false)
        local position = mp.get_property_number("time-pos", last_position)
        if stalled and not was_stalled and started then stalls = stalls + 1 end
        was_stalled = stalled
        if not stalled and position > 0.1 then started = true end
        if not ended then
            last_position = position
            last_duration = mp.get_property_number("duration", last_duration)
        end
        local av = mp.get_property_number("avsync", 0)
        max_av = math.max(max_av, math.abs(av))
        -- Unavailable properties can also return an error string at EOF.
        -- Parentheses pass only the numeric value/default to math.max.
        max_drop = math.max(max_drop, (mp.get_property_number("frame-drop-count", 0)))
        max_decoder_drop = math.max(max_decoder_drop, (mp.get_property_number("decoder-frame-drop-count", 0)))
        local state = {
            position = last_position, duration = last_duration,
            cache_seconds = mp.get_property_number("demuxer-cache-duration", 0),
            paused = mp.get_property_bool("pause", false),
            buffering = stalled, stalls = stalls, started = started,
            dropped = max_drop, decoder_dropped = max_decoder_drop,
            avsync = av, max_avsync = max_av,
            ended = ended or false, reason = reason
        }
        local file = io.open(path, "w")
        if file then file:write(utils.format_json(state)); file:close() end
    end
    mp.add_periodic_timer(0.5, function() save(false) end)
    mp.register_event("end-file", function(event) save(true, event.reason) end)
end
