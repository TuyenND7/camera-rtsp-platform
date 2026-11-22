import unittest
from app.surveillance import SurveillanceRules, policy, inside, zones_for


def item(x=.5, y=.5, track='c1-abcdef123456-1', identity=None, label='person'):
    return dict(track_id=track, track_number=1, label=label, box=[(x-.05)*100,(y-.2)*100,(x+.05)*100,y*100], identity=identity)


class SurveillanceTests(unittest.TestCase):
    def test_person_footpoint_matches_normalized_display_and_not_a_cropped_torso(self):
        zones = [dict(id='corner',name='Góc sân',points=[[.5,.5],[1,.5],[1,1],[.5,1]])]
        settings = policy(dict(zones_enabled=True,zones=zones))
        self.assertEqual(len(zones_for(item(.6,.6),100,100,settings)),1)
        self.assertEqual(zones_for(item(.4,.6),100,100,settings),[])
        self.assertTrue(inside((.5,.5), zones[0]['points']))
        self.assertFalse(inside((.49,.5), zones[0]['points']))
        self.assertEqual(zones_for(item(),100,100,policy(dict(zones_enabled=True))),[])
        upper=policy(dict(zones_enabled=True,zones=[dict(id='top',name='Top',points=[[0,0],[1,0],[1,.5],[0,.5]])]))
        self.assertEqual(zones_for(item(.5,.6),100,100,upper),[])  # torso overlaps, feet outside

    def test_intrusion_waits_for_multiple_observations_and_only_people(self):
        rules = SurveillanceRules(); settings = policy(dict(intrusion_enabled=True))
        self.assertEqual(rules.evaluate([item()],100,100,100,settings),[])
        self.assertEqual(rules.evaluate([item()],101,100,100,settings),[])
        alerts = rules.evaluate([item()],102,100,100,settings)
        self.assertEqual([a['kind'] for a in alerts],['intrusion'])
        rules.committed(alerts[0],102)
        self.assertEqual(rules.evaluate([item()],103,100,100,settings),[])
        self.assertEqual(rules.evaluate([item(label='cat')],150,100,100,settings),[])

    def test_failed_write_can_retry_and_distinct_people_are_not_suppressed_by_cooldown(self):
        rules = SurveillanceRules(); settings = policy(dict(intrusion_enabled=True))
        rules.evaluate([item()],100,100,100,settings)
        alerts = rules.evaluate([item()],102,100,100,settings)
        self.assertEqual(len(alerts),1)
        retry = rules.evaluate([item()],103,100,100,settings)
        self.assertEqual(len(retry),1)
        rules.committed(retry[0],103)
        other = item(track='c1-abcdef123456-2')
        rules.evaluate([other],104,100,100,settings)
        self.assertEqual(len(rules.evaluate([other],106,100,100,settings)),1)

    def test_long_absence_and_leaving_zone_reset_dwell(self):
        rules = SurveillanceRules(); settings = policy(dict(loitering_enabled=True,loitering_seconds=15))
        for at in range(100,110): self.assertEqual(rules.evaluate([item()],at,100,100,settings),[])
        rules.evaluate([],111,100,100,settings)
        self.assertEqual(rules.evaluate([item()],120,100,100,settings),[])
        self.assertEqual(rules.evaluate([item()],121,100,100,settings),[])
        for at in range(122,135): self.assertEqual(rules.evaluate([item()],at,100,100,settings),[])
        self.assertEqual(rules.evaluate([item()],135,100,100,settings)[0]['kind'],'loitering')

    def test_unknown_face_requires_nonempty_ready_gallery_and_actual_unmatched_face(self):
        settings = policy(dict(unfamiliar_enabled=True))
        for state, ready in [('unmatched',False),('not_visible',True),('pending',True),('unavailable',True),('known',True)]:
            rules = SurveillanceRules()
            for at in range(100,110):
                self.assertEqual(rules.evaluate([item(identity={'state':state})],at,100,100,settings,identities_ready=ready),[])
        rules = SurveillanceRules()
        for at in [100,101]: self.assertEqual(rules.evaluate([item(identity={'state':'unmatched'})],at,100,100,settings,identities_ready=True),[])
        self.assertEqual(rules.evaluate([item(identity={'state':'unmatched'})],102,100,100,settings,identities_ready=True)[0]['kind'],'unfamiliar')

    def test_pacing_rejects_box_jitter_and_detects_substantial_reversals(self):
        settings = policy(dict(pacing_enabled=True,pacing_reversals=3))
        rules = SurveillanceRules()
        for at in range(100,120): self.assertEqual(rules.evaluate([item(.5+(at%2)*.005)],at,100,100,settings),[])
        alerts = []
        for at,x in enumerate([.2,.4,.6,.4,.2,.4,.6,.4,.2],120):
            alerts += rules.evaluate([item(x)],at,100,100,settings)
        self.assertTrue(any(a['kind']=='pacing' and a['metrics']['reversals']>=3 for a in alerts))

    def test_rules_off_and_out_of_order_frames_never_emit(self):
        rules = SurveillanceRules()
        for at in range(100,400): self.assertEqual(rules.evaluate([item()],at,100,100,policy()),[])
        self.assertEqual(rules.evaluate([item()],200,100,100,policy(dict(intrusion_enabled=True))),[])

    def test_switching_policy_does_not_reuse_old_dwell(self):
        rules = SurveillanceRules()
        settings = policy(dict(loitering_enabled=True,loitering_seconds=15))
        for at in range(100,110): rules.evaluate([item()],at,100,100,settings)
        updated = {**settings,'loitering_seconds':30}
        self.assertEqual(rules.evaluate([item()],110,100,100,updated),[])
        self.assertEqual(next(iter(rules.states.values()))['first'],110)


if __name__ == '__main__': unittest.main()
