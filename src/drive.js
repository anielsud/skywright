// Driving modes for cars (four wheels or more). The realism choice (REALISM in aircraft.js) is a plane idea; for a car
// the same three slots are the driving modes, with their own names and their own feel. aircraft.js reads the mode's
// numbers in the car-only code (steering, tyres, assists); planes, helicopters and rockets never look here. Bikes keep
// their own per-mode rider (bike.js), under the same names.
//
//   Easy  (arcade): the steering is sharp, sticky tyres, an invisible hand keeps the wheels down (it can't roll over),
//                   a yaw helper points the car where you steer, and a gentler top speed.
//   Racer (pilot):  grippy race tyres, traction control (the wheels never spin away your steering) and ABS (you can
//                   steer while braking hard), and the handbrake throws it into a drift that the car holds for you.
//   Pro   (sim):    no help at all: road tyres, the steering only stops where the car would tip in a steady turn, a
//                   wheel that spins or locks slides, the handbrake can spin you, and a hard swerve can roll it.
//
// turnG:   how hard (in g) full lock asks the car to corner at speed (the lock is cut back as speed rises so it asks
//          for no more than this); Pro also stops short of the car's own rollover limit (cornerG, steerGeometry).
// latMu:   the tyres' side grip (Pro: 0.9, a real road tyre).
// antiRoll: how much of the tyres' rolling moment is cancelled (1: the car never leans or tips from cornering).
// yawHelp: how firmly the car's yaw rate is pulled to what the steering asks for (crisp turn-in, no spins).
// top:     top speed, as a share of the engine's own.
// tc/abs:  traction control and ABS: driving and braking only use the grip that steering leaves over.
// drift:   the handbrake drift helper: the back steps out, the gas keeps pushing, the slide is held below driftMax rad.
export const DRIVE = {
  arcade: { id: 'arcade', name: 'Easy', desc: 'Sharp steering, sticky tyres. It can’t roll over. Gentle top speed.', turnG: 1.3, latMu: 1.3, antiRoll: 1, yawHelp: 1, top: 0.8, tc: 1, abs: 1, drift: 0.6, driftMax: 0.4 },
  pilot: { id: 'pilot', name: 'Racer', desc: 'Race tyres, traction control and ABS. Handbrake + steer to drift!', turnG: 1.1, latMu: 1.1, antiRoll: 0.65, yawHelp: 0.45, top: 1, tc: 1, abs: 1, drift: 1, driftMax: 0.6 },
  sim: { id: 'sim', name: 'Pro', desc: 'No help: real tyre grip, wheels spin and lock, and you can roll it.', turnG: 1, latMu: 0.9, antiRoll: 0, yawHelp: 0, top: 1, tc: 0, abs: 0, drift: 0, driftMax: 0 },
};
export const driveMode = (R) => DRIVE[R?.id] || DRIVE.pilot;
