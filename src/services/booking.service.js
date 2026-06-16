const crypto = require('crypto');
const {
  Package,
  AvailableRoom,
  Hotel,
  Event,
  EventType,
  AddOnActivity,
  EventActivity,
  Location,
  City,
  Booking,
} = require('../models');

const { priceUnitLabel } = require('../config/priceType');

const TAX_RATE = Number(process.env.BOOKING_TAX_RATE || 0.18); // 18% GST default
const ALLOWED_TYPES = ['package', 'room', 'event', 'addon', 'event_activity'];

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const fromPaise = (paise) => Number(paise || 0) / 100;

const generateBookingCode = async () => {
  // RBT-YYYY-XXXXXX (X = uppercase hex). Loop on the (extremely unlikely)
  // collision so we never write two bookings with the same public code.
  const year = new Date().getFullYear();
  for (let i = 0; i < 6; i++) {
    const tail = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `RBT-${year}-${tail}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await Booking.findOne({ where: { bookingCode: code }, attributes: ['id'] });
    if (!exists) return code;
  }
  return `RBT-${year}-${Date.now().toString(36).toUpperCase()}`;
};

// Fetch the bookable item in a uniform shape. Returns null for missing/inactive
// items so the controller can return a clean 404.
const fetchItem = async (type, id) => {
  if (!ALLOWED_TYPES.includes(type)) return null;
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId <= 0) return null;

  if (type === 'package') {
    const pkg = await Package.findByPk(numId, {
      include: [
        { model: City, as: 'city', attributes: ['id', 'name'] },
        { model: Location, as: 'location', attributes: ['id', 'name'] },
      ],
    });
    if (!pkg || pkg.isActive === false) return null;
    const j = pkg.toJSON();
    return {
      type: 'package',
      id: j.id,
      name: j.name,
      slug: j.slug,
      image: j.primaryImage,
      price: Number(j.priceFrom || 0),
      priceOriginal: j.priceOriginal ? Number(j.priceOriginal) : null,
      currency: j.currency || 'INR',
      gstRate: Number(j.gstRate) || 0,
      tcsRate: Number(j.tcsRate) || 0,
      priceType: j.priceType || 'per_person',
      priceLabel: j.priceLabel || null,
      location: j.location?.name || j.city?.name || j.locationDetail || null,
      detailHref: `/retreats/${j.slug}`,
      meta: {
        durationDays: j.durationDays,
        durationNights: j.durationNights,
        minGroupSize: j.minGroupSize,
        maxGroupSize: j.maxGroupSize,
        startDate: j.startDate,
        endDate: j.endDate,
        availableAllYear: !!j.availableAllYear,
      },
    };
  }

  if (type === 'room') {
    const room = await AvailableRoom.findByPk(numId, {
      include: [
        {
          model: Hotel,
          as: 'hotel',
          attributes: ['id', 'name', 'slug'],
          include: [
            { model: Location, as: 'location', attributes: ['id', 'name'] },
            { model: City, as: 'city', attributes: ['id', 'name'] },
          ],
        },
      ],
    });
    if (!room || room.isActive === false) return null;
    const j = room.toJSON();
    return {
      type: 'room',
      id: j.id,
      name: j.name,
      slug: j.slug,
      image: j.mainImage,
      price: Number(j.price || 0),
      priceOriginal: j.priceOriginal ? Number(j.priceOriginal) : null,
      currency: j.currency || 'INR',
      gstRate: Number(j.gstRate) || 0,
      tcsRate: Number(j.tcsRate) || 0,
      priceType: j.priceType || 'per_night',
      priceLabel: j.priceLabel || null,
      location: j.hotel?.location?.name || j.hotel?.city?.name || null,
      hotel: j.hotel ? { id: j.hotel.id, name: j.hotel.name, slug: j.hotel.slug } : null,
      detailHref: j.hotel?.slug ? `/hotels/${j.hotel.slug}/rooms/${j.slug}` : null,
      meta: {
        roomSize: j.roomSize,
        maxOccupancy: j.maxOccupancy,
        extraPersonTiers: Array.isArray(j.extraPersonTiers) ? j.extraPersonTiers : [],
      },
    };
  }

  if (type === 'event') {
    const event = await Event.findByPk(numId, {
      include: [
        { model: EventType, as: 'eventType', attributes: ['id', 'name', 'isSport'] },
        { model: Location, as: 'location', attributes: ['id', 'name'] },
      ],
    });
    if (!event || event.isActive === false) return null;
    const j = event.toJSON();
    return {
      type: 'event',
      id: j.id,
      name: j.name,
      slug: j.slug,
      image: j.mainImage,
      price: Number(j.price || 0),
      priceOriginal: j.priceOriginal ? Number(j.priceOriginal) : null,
      currency: j.currency || 'INR',
      gstRate: Number(j.gstRate) || 0,
      tcsRate: Number(j.tcsRate) || 0,
      priceType: j.priceType || 'per_person',
      priceLabel: j.priceLabel || null,
      location: j.location?.name || null,
      detailHref: `/events/${j.slug}`,
      meta: {
        eventDate: j.eventDate,
        startTime: j.startTime,
        endTime: j.endTime,
        eventTypeName: j.eventType?.name,
        isSport: !!j.eventType?.isSport,
        minAge: j.minAge,
        maxAge: j.maxAge,
      },
    };
  }

  if (type === 'addon') {
    const addon = await AddOnActivity.findByPk(numId, {
      include: [{ model: Location, as: 'location', attributes: ['id', 'name'] }],
    });
    if (!addon || addon.isActive === false) return null;
    const j = addon.toJSON();
    return {
      type: 'addon',
      id: j.id,
      name: j.name,
      slug: j.slug,
      image: j.mainImage,
      price: Number(j.price || 0),
      priceOriginal: j.priceOriginal ? Number(j.priceOriginal) : null,
      currency: j.currency || 'INR',
      gstRate: Number(j.gstRate) || 0,
      tcsRate: Number(j.tcsRate) || 0,
      priceType: j.priceType || 'per_person',
      priceLabel: j.priceLabel || null,
      location: j.location?.name || null,
      detailHref: `/add-ons/${j.slug}`,
      meta: {
        minAge: j.minAge,
        maxAge: j.maxAge,
      },
    };
  }

  if (type === 'event_activity') {
    const ea = await EventActivity.findByPk(numId);
    if (!ea || ea.isActive === false) return null;
    const j = ea.toJSON();
    // Price = cheapest ticket, else adult price.
    const ticketPrices = (Array.isArray(j.tickets) ? j.tickets : [])
      .map((t) => Number(t.price) || 0).filter((p) => p > 0);
    const price = ticketPrices.length ? Math.min(...ticketPrices) : Number(j.adultPrice || 0);
    return {
      type: 'event_activity',
      id: j.id,
      name: j.title,
      slug: j.slug,
      image: j.thumbnail || j.mainBanner,
      price,
      currency: j.currency || 'INR',
      gstRate: Number(j.gstRate) || 0,
      location: j.city || j.venueName || null,
      detailHref: `/events-activities/${j.slug}`,
      meta: { category: j.category, startDate: j.startDate },
    };
  }

  return null;
};

// Per-night charge (in paise) for one extra person, based on the room's tiers.
// Matches by age band AND bed preference (with/without) — falling back to an
// age-only match. Free / unmatched persons cost nothing.
const extraPersonPaise = (tiers, person) => {
  if (!Array.isArray(tiers)) return 0;
  const a = Number(person?.age);
  if (Number.isNaN(a)) return 0;
  const bed = person?.bed === 'with' ? 'with' : 'without';
  const inBand = (t) => a >= Number(t.ageFrom) && a <= Number(t.ageTo);
  const tier = tiers.find((t) => inBand(t) && t.bed === bed) || tiers.find(inBand);
  if (!tier || tier.priceType !== 'custom') return 0;
  return toPaise(tier.price);
};

// Compute the pricing breakdown for a given item + booking inputs. All math
// is in paise so we never lose a rupee to float rounding.
const computePricing = ({
  item,
  guestCount = 1,
  units = 1,
  roomCount = 1,
  extraPersons = [],
  walletPaise = 0,
  couponDiscountPaise = 0,
}) => {
  const unitPricePaise = toPaise(item.price);
  const extras = Array.isArray(extraPersons) ? extraPersons : [];

  // The admin-chosen priceType drives the multiplier (falls back to the legacy
  // per-type default for items created before the column existed):
  //   per_night  → × nights (× rooms for hotel rooms, + per-night extras)
  //   per_person → × guests
  //   package / custom → flat (× rooms for hotel rooms, × 1 otherwise)
  const priceType = item.priceType || (item.type === 'room' ? 'per_night' : 'per_person');
  const nights = Math.max(1, Number(units || 1));
  const guests = Math.max(1, Number(guestCount || 1));
  let quantity;
  let roomsResolved = Math.max(1, Number(roomCount || 1));
  let extraPersonsPaise = 0;

  if (item.type === 'room') {
    const maxOcc = Math.max(1, Number(item.meta?.maxOccupancy || 2));
    // Auto-grow the room count when the party spills past one room's occupancy.
    const totalPeople = guests + extras.length;
    roomsResolved = Math.max(roomsResolved, Math.ceil(totalPeople / maxOcc));
    if (priceType === 'per_person') {
      quantity = totalPeople;
    } else if (priceType === 'package' || priceType === 'custom') {
      quantity = roomsResolved;
    } else { // per_night
      quantity = nights * roomsResolved;
      const tiers = item.meta?.extraPersonTiers || [];
      const perNightExtra = extras.reduce((sum, p) => sum + extraPersonPaise(tiers, p), 0);
      extraPersonsPaise = perNightExtra * nights;
    }
  } else if (priceType === 'per_night') {
    quantity = nights;
  } else if (priceType === 'package' || priceType === 'custom') {
    quantity = 1;
  } else { // per_person (default for package / event / addon)
    quantity = guests;
  }

  const subtotalPaise = unitPricePaise * quantity + extraPersonsPaise;
  // Per-item GST rate (0 = Off, the default). Falls back to the platform
  // default only when the item predates the gstRate column (undefined).
  const itemRate = item.gstRate == null ? TAX_RATE : Number(item.gstRate) / 100;
  const tcsRate = item.tcsRate == null ? 0 : Number(item.tcsRate) / 100;
  const gstPaise = Math.round(subtotalPaise * itemRate);
  const tcsPaise = Math.round((subtotalPaise + gstPaise) * tcsRate);
  const taxPaise = gstPaise + tcsPaise;

  // Discounts are applied after tax (matches MMT's display). Clamp so we
  // never go below zero — defensive in case a coupon overshoots.
  const grossPaise = subtotalPaise + taxPaise;
  const walletDiscountPaise = Math.min(Math.max(0, Number(walletPaise || 0)), grossPaise);
  const remaining = grossPaise - walletDiscountPaise;
  const safeCoupon = Math.min(Math.max(0, Number(couponDiscountPaise || 0)), remaining);
  const totalPaise = grossPaise - walletDiscountPaise - safeCoupon;

  return {
    quantity,
    roomsResolved,
    extraPersonsCount: extras.length,
    extraPersonsPaise,
    currency: item.currency || 'INR',
    unitPricePaise,
    subtotalPaise,
    gstPaise,
    tcsPaise,
    taxPaise,
    taxRate: itemRate,
    gstRate: item.gstRate == null ? null : Number(item.gstRate),
    tcsRate: item.tcsRate == null ? null : Number(item.tcsRate),
    priceType,
    priceUnitLabel: priceUnitLabel(priceType, item.priceLabel),
    walletDiscountPaise,
    couponDiscountPaise: safeCoupon,
    totalPaise,
    display: {
      unitPrice: fromPaise(unitPricePaise),
      subtotal: fromPaise(subtotalPaise),
      gst: fromPaise(gstPaise),
      tcs: fromPaise(tcsPaise),
      tax: fromPaise(taxPaise),
      extraPersons: fromPaise(extraPersonsPaise),
      walletDiscount: fromPaise(walletDiscountPaise),
      couponDiscount: fromPaise(safeCoupon),
      total: fromPaise(totalPaise),
    },
  };
};

// Build the canonical item snapshot we persist on the Booking row. The fields
// we save are exactly what the voucher / details modal needs to render later,
// fully independent of the source row.
const buildItemSnapshot = (item) => ({
  type: item.type,
  id: item.id,
  name: item.name,
  slug: item.slug,
  image: item.image,
  location: item.location,
  detailHref: item.detailHref,
  hotel: item.hotel || null,
  meta: item.meta || {},
  pricedAt: {
    price: item.price,
    currency: item.currency || 'INR',
    gstRate: item.gstRate == null ? null : Number(item.gstRate),
    tcsRate: item.tcsRate == null ? null : Number(item.tcsRate),
    priceType: item.priceType || null,
    priceLabel: item.priceLabel || null,
  },
});

// Compute units & sensible defaults given user-supplied dates. Pure function —
// callers feed it the raw input, get back canonical scheduledFor / units.
const resolveSchedule = ({ item, scheduledFor, scheduledEndAt }) => {
  // Event dates are locked to the event row — ignore client input.
  if (item.type === 'event') {
    return {
      scheduledFor: item.meta?.eventDate || scheduledFor || null,
      scheduledEndAt: null,
      units: 1,
    };
  }

  // Rooms always need a check-in AND check-out so units (nights) is positive.
  if (item.type === 'room') {
    const start = scheduledFor ? new Date(scheduledFor) : null;
    const end = scheduledEndAt ? new Date(scheduledEndAt) : null;
    let nights = 1;
    if (start && end) {
      const ms = end.getTime() - start.getTime();
      nights = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
    }
    return {
      scheduledFor: scheduledFor || null,
      scheduledEndAt: scheduledEndAt || null,
      units: nights,
    };
  }

  // Packages span durationDays; default end if user gave a start but no end.
  if (item.type === 'package') {
    let end = scheduledEndAt;
    if (!end && scheduledFor && item.meta?.durationDays) {
      const d = new Date(scheduledFor);
      d.setDate(d.getDate() + Math.max(0, (item.meta.durationDays || 1) - 1));
      end = d.toISOString().slice(0, 10);
    }
    return {
      scheduledFor: scheduledFor || null,
      scheduledEndAt: end || null,
      units: item.meta?.durationDays || 1,
    };
  }

  // Add-ons are single-day experiences.
  return {
    scheduledFor: scheduledFor || null,
    scheduledEndAt: null,
    units: 1,
  };
};

module.exports = {
  ALLOWED_TYPES,
  TAX_RATE,
  fetchItem,
  computePricing,
  buildItemSnapshot,
  resolveSchedule,
  generateBookingCode,
  toPaise,
  fromPaise,
};
